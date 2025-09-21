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

    // 모델 경로 결정 (샤드/단일 모두 커버)
    let modelPath = '';
    try {
      const files = fs.readdirSync(modelsDir);
      const shard = files.find(f => /-00001-of-\d+\.gguf$/.test(f));
      modelPath = path.join(modelsDir, shard ?? files.find(f => f.endsWith('.gguf')) ?? '');
    } catch {}

    console.log('[electron] loading model:', modelPath);
    const model = await llama.loadModel({ modelPath });
    const context = await model.createContext();
    ctx = context; // 나중엔 maxTokens 등에 씀
    session = new LlamaChatSession({ contextSequence: context.getSequence() });

    // (A) 내 JSON 스키마로 grammar 생성 (권장)
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

    // (B) 혹은 내장 JSON grammar (형식만 JSON, 키 고정은 아님)
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

ipcMain.handle('llm:prompt', async (_e, { prompt }) => {
  if (!session) throw new Error('Model not ready');

  // 프롬프트엔 "무엇을 써야 하는지" 의미만 남기고,
  // 형식 강제는 grammar가 담당
  const reply = await session.prompt(prompt, {
    grammar: jsonGrammar,
    // 일부 grammar에서 멈춤 이슈가 있어 context 크기 정도로 제한 권장
    maxTokens: ctx?.contextSize ?? 2048
  });
  console.log('[electron] reply:', reply);
  const result = jsonGrammar.parse(reply); // 안전한 JS 객체
  return result; // 항상 유효 JSON
});

