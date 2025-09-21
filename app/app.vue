<template>
  <div class="wrap">
    <header class="top">
      <h1>Qwen NPC 대화</h1>
      <button class="log" @click="showLog = true">로그</button>
    </header>

    <main class="scene">
      <div class="bubble" :class="{ npc: true }">
        <p>{{ displayedNpcLine }}</p>
      </div>
    </main>

    <footer class="bottom">
      <input
        :value="input"
        @input="input = ($event.target as HTMLInputElement).value"
        @keydown.enter="send"
        class="chat"
        placeholder="메시지를 입력하고 Enter"
        :disabled="isBusy"
      />
      <button @click="send" :disabled="isBusy">전송</button>
    </footer>

    <dialog v-if="showLog" class="log-dialog" open>
      <header>
        <h3>대화 로그</h3>
        <button @click="showLog = false">닫기</button>
      </header>
      <section class="logs" style="display: flex; flex-direction: column; gap: 12px;">
        <div v-for="(m,i) in messages" :key="i" style="display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; gap: 4px;">
            <div style="font-size: 12px; font-weight: bold;">{{ m.role === 'user' ? '사용자' : 'NPC' }}</div>
            <div style="font-size: 14px;">{{ m.text }}</div>
          </div>
          <div v-if="m.role === 'assistant'" style="display: flex; flex-direction: column; gap: 2px;">
            <div style="font-size: 12px; color: #555;">positive: {{ m.positivePrompt }}</div>
            <div style="font-size: 12px; color: #555;">negative: {{ m.negativePrompt }}</div>
          </div>
        </div>
      </section>
    </dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { typewrite } from '../components/typewrite'

type Reply = {
  answer: string
  positivePrompt: string
  negativePrompt: string
}

const input = ref('')
const showLog = ref(false)
const messages = ref<{ role: 'user' | 'assistant'; text: string; positivePrompt?: string; negativePrompt?: string }[]>([])

const npcCurrent = ref('') // 초기 고정 문구 제거
const displayedNpcLine = computed(() => npcCurrent.value || (isBusy.value ? '...' : ''))
const isBusy = ref(false)

const BASE_INSTRUCTION = [
  '너는 게임 속 NPC "미샤"다.',
  '항상 한국어로 대답한다.',
  '미샤는 고양이 귀를 가진 붉은 머리 수인 소녀이며, 말 끝에 "냥"을 붙이고 츤데레적인 성격을 가진다.',
  '다음 세 가지 필드를 JSON으로 채워라:',
  '- answer: 사용자에게 보일 짧은 대답 (캐릭터 말투 유지)',
  '- positivePrompt: 미샤의 외형을 묘사하는 이미지 생성용 긍정 프롬프트',
  '- negativePrompt: 이미지 생성 시 피해야 할 요소를 담은 네거티브 프롬프트'
].join('\n');

async function greet() {
  if (isBusy.value) return
  try {
    isBusy.value = true
    // “사용자 메시지 없이 먼저 말을 건다”는 상황을 명시
    const system = [
      BASE_INSTRUCTION,
      '상황: 플레이어가 아직 말을 걸지 않았다. 네가 먼저 간단히 인사하고 관심을 유도해라.',
      '톤: 츤데레+상냥. 1~2문장. 과도하게 길지 않게.'
    ].join('\n')

    const api = window.electronAPI
    const reply = (await api?.invoke('llm:prompt', { prompt: system })) as Reply;

    await typewrite(npcCurrent, reply.answer, { cps: 26 })
    messages.value.push({
      role: 'assistant',
      text: reply.answer,
      positivePrompt: reply.positivePrompt,
      negativePrompt: reply.negativePrompt,
    })
  } catch {
    npcCurrent.value = '모델 초기화 중이거나 오류가 발생했어요.'
  } finally {
    isBusy.value = false
  }
}

async function send() {
  if (isBusy.value) return
  const text = input.value.trim()
  if (!text) return

  messages.value.push({ role: 'user', text })
  input.value = ''

  try {
    isBusy.value = true
    const instruction = [
      BASE_INSTRUCTION,
      `대화 이력 요약: 최근 NPC 발화는 "${npcCurrent.value.slice(0, 60)}..."`,
      '아래 사용자 메시지에 캐릭터 말투로 반응하라.'
    ].join('\n')
    const fullPrompt = `${instruction}\n\n사용자 메시지: ${text}`

    const api = window.electronAPI
    const reply = (await api?.invoke('llm:prompt', { prompt: fullPrompt })) as Reply;

    await typewrite(npcCurrent, reply.answer, { cps: 26 })
    messages.value.push({
      role: 'assistant',
      text: reply.answer,
      positivePrompt: reply.positivePrompt,
      negativePrompt: reply.negativePrompt,
    })
  } catch {
    npcCurrent.value = '모델 초기화 중이거나 오류가 발생했어요.'
  } finally {
    isBusy.value = false
  }
}

onMounted(() => {
  // 앱 시작 시 미샤가 먼저 말 걸기
  void greet()
})
</script>

<style scoped>
.wrap { display: flex; flex-direction: column; height: 100vh; }
.top { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #eee; }
.scene { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; }
.bubble { max-width: 720px; background: #f6f7fb; border: 1px solid #e5e7ef; border-radius: 12px; padding: 18px 20px; font-size: 16px; line-height: 1.6; color: #333; }
.bottom { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #eee; }
.chat { flex: 1; padding: 10px 12px; border: 1px solid #cfd3dc; border-radius: 8px; font-size: 14px; }
.log-dialog { width: 720px; max-width: calc(100vw - 40px); border: 1px solid #ddd; border-radius: 12px; padding: 0; }
.log-dialog header { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; border-bottom: 1px solid #eee; }
.logs { max-height: 60vh; overflow: auto; padding: 12px 14px; }
.log-row { display: grid; grid-template-columns: 80px 1fr; gap: 12px; padding: 8px 0; border-bottom: 1px dashed #eee; }
.role { color: #555; }
.text { white-space: pre-wrap; }

/* 세 점 깜빡임 타이핑 인디케이터 */
.typing::after {
  content: '…';
  animation: blink 1s steps(1) infinite;
}
@keyframes blink {
  50% { opacity: 0; }
}

</style>
