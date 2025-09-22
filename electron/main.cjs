const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { pathToFileURL } = require('url')

let mainWindow
let session
let jsonGrammar
let ctx

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })

  const devServerUrl = process.env.VITE_DEV_SERVER_URL
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl)
    mainWindow.webContents.openDevTools()
  } else {
    const indexPath = path.join(__dirname, '../.output/public/index.html')
    const indexUrl = pathToFileURL(indexPath).toString()
    console.log('[electron] loadURL(file):', indexUrl)
    mainWindow.loadURL(indexUrl)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    console.error('[electron] did-fail-load', { errorCode, errorDescription, validatedURL })
  })

  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log('[renderer]', { level, message, line, sourceId })
  })
}

async function initModel() {
  try {
    const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
    const llama = await getLlama();

    const modelsDir = app.isPackaged
      ? path.join(process.resourcesPath, 'models')
      : path.join(__dirname, '..', 'models');

    // Find a GGUF model file under models directory (recursively)
    function findFirstGguf(searchDir) {
      const entries = fs.readdirSync(searchDir, { withFileTypes: true });
      for (const entry of entries) {
        const p = path.join(searchDir, entry.name);
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) return p;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const found = findFirstGguf(path.join(searchDir, entry.name));
          if (found) return found;
        }
      }
      return null;
    }

    const qwen14bDir = path.join(modelsDir, 'qwen3-14b');
    const ggufPath = findFirstGguf(qwen14bDir);

    if (!ggufPath) {
      // Give a helpful error if only safetensors are present
      const hasSafetensors = (() => {
        let found = false;
        const stack = [modelsDir];
        while (stack.length) {
          const dir = stack.pop();
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const p = path.join(dir, entry.name);
            if (entry.isFile() && entry.name.toLowerCase().endsWith('.safetensors')) {
              found = true;
              break;
            }
            if (entry.isDirectory()) stack.push(p);
          }
          if (found) break;
        }
        return found;
      })();

      console.error('[electron] No GGUF model found under', modelsDir);
      if (hasSafetensors) {
        console.error('[electron] Detected .safetensors files. node-llama-cpp only supports GGUF (llama.cpp) models.');
        console.error('[electron] Please place a Qwen GGUF file (e.g. qwen2.5-7b-instruct-q4_k_m.gguf) under the models folder.');
      }
      return;
    }

    console.log('[electron] Loading GGUF model:', ggufPath);

    const model = await llama.loadModel({ modelPath: ggufPath });
    const context = await model.createContext();
    ctx = context;
    session = new LlamaChatSession({ contextSequence: context.getSequence() });

    // (A) Create a grammar for your JSON schema (recommended)
    jsonGrammar = await llama.createGrammarForJsonSchema({
      type: 'object',
      properties: {
        answer: { type: 'string' },
        positivePrompt: { type: 'string' },
        negativePrompt: { type: 'string' }
      },
      required: ['answer', 'positivePrompt', 'negativePrompt'],
      additionalProperties: false
    });

    // (B) Or use the built-in JSON grammar (enforces JSON format, but not specific keys)
    // jsonGrammar = await llama.getGrammarFor('json');

    console.log('LLM session + grammar ready');
  } catch (err) {
    console.error('Failed to init LLM:', err);
  }
}

app.whenReady().then(async () => {
  await initModel()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function chatmlFromTurns(system, turns = []) {
  const parts = []
  parts.push(`<|im_start|>system`)
  parts.push((system ?? '').trim())
  parts.push(`<|im_end|>`)
  for (const t of turns) {
    const role = t && t.role === 'assistant' ? 'assistant' : 'user'
    const text = (t && t.text ? String(t.text) : '').trim()
    parts.push(`<|im_start|>${role}`)
    parts.push(text)
    parts.push(`<|im_end|>`)
  }
  // 다음 assistant 메시지(JSON)를 생성하도록 시작만 열어둔다
  parts.push(`<|im_start|>assistant\n`)
  return parts.join('\n')
}

ipcMain.handle('llm:prompt', async (_e, payload) => {
  if (!session) throw new Error('Model not ready');

  // {system, turns} 전용
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid payload: expected { system, turns }')
  }
  const { system, turns } = payload
  if (typeof system !== 'string') {
    throw new Error('Invalid payload: "system" must be a string')
  }
  if (!Array.isArray(turns)) {
    throw new Error('Invalid payload: "turns" must be an array')
  }

  const prompt = chatmlFromTurns(system, turns)

  console.log('[electron] prompt:', prompt);
  const reply = await session.prompt(prompt, {
    grammar: jsonGrammar,
    maxTokens: 1024,
    // Qwen 권장에 맞춰 샘플링 조정 (비-thinking 모드 기준)
    temperature: 0.7,
    topP: 0.8,
    topK: 20,
    presencePenalty: 1.5,
    repeatPenalty: 1.05, // 기존 값 유지 (원하면 1.1~1.15로 미세조정 가능)
    // 문법 비활성 시를 대비한 예비 stop 토큰 (grammar 사용 중에는 무시됨)
    stop: ["<|im_end|>", "<|endoftext|>"],
  });
  console.log('[electron] reply:', reply);
  const result = jsonGrammar.parse(reply); // Safely parse into a JS object
  return result; // Always a valid JSON
});
