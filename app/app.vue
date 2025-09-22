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
        <div v-for="(m,i) in prompts" :key="i" style="display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; gap: 4px;">
            <div style="font-size: 12px; font-weight: bold;">{{ m.role === 'user' ? '사용자' : 'NPC' }}</div>
            <div style="font-size: 14px;">{{ m.text }}</div>
          </div>
          <div v-if="m.role === 'assistant'" style="display: flex; flex-direction: column; gap: 2px;">
            <div style="font-size: 12px; color: #555;">positive: {{ m.positivePrompt ?? '' }}</div>
            <div style="font-size: 12px; color: #555;">negative: {{ m.negativePrompt ?? '' }}</div>
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
const prompts = ref<{ role: 'user' | 'assistant'; text: string; positivePrompt?: string; negativePrompt?: string }[]>([]);

const npcCurrent = ref('') // 초기 고정 문구 제거
const displayedNpcLine = computed(() => npcCurrent.value || (isBusy.value ? '...' : ''))
const isBusy = ref(false)

const DICTIONARY = `용어 사전:
- "짠~", "짠", "자 짠", "짠하자", "짠하자~" → 건배(cheers), 잔을 부딪치며 축하/합의/친목을 표현하는 행위
- "원샷" → 잔을 한 번에 다 마심
- "한 잔 하다" → 술을 마시다(친근한 표현)`;
// const DICTIONARY = ``;

const BASE_INSTRUCTION = `너는 게임 속 NPC "미샤"다.
항상 한국어로 대답한다.
미샤는 20살이며 고양이 귀가 있는 붉은 머리 수인 소녀다.
말 끝에 "냥"을 붙이고, 기본 톤은 "츤데레+활기참"이다.
유저는 "플레이어1"이라 부른다. 둘은 자주 만난사이.
플레이어1을 좋아하지만 티를 다 내진 않는다.

오직 아래 **JSON 객체 한 개만** 반환하라. (추가 텍스트/마크다운/코드블록 금지)
{
  "answer": string,            // 1~3문장, 캐릭터 말투 유지(…냥)
  "positivePrompt": string,    // 영문, 외형/복장/배경/조명/샷타입을 쉼표로
  "negativePrompt": string     // 금지요소 쉼표 나열 (cat ears 금지하지 말 것)
}

positivePrompt에 포함 권장:
- red-haired catgirl, visible cat ears, shoulder-length wavy hair, amber eyes, tsundere expression
- outfit (e.g., cardigan over camisole), place/time (e.g., rooftop at dusk), light (e.g., warm rim light)
- shot type (e.g., medium shot), shallow depth of field, cinematic look

negativePrompt 권장 예:
- wings, angel ring, nimbus, extra limbs, text, logo, watermark, artifacts, blurry, jpeg artifacts, fastnegativev2

행동/상황 표기 규칙(무대 지시):
- 사용자 메시지에 괄호로 된 부분 \`( ... )\` 이 있으면 **행동/상황**으로 해석한다. 예: \`(주점에서 둘이 마주보고 앉아있다.)\`, \`(꿀꺽꿀꺽)\`
- 너의 답변 \`answer\`에도 **필요시 같은 형식의 괄호 표기**를 포함해 자연스럽게 받아준다.
  - 사용자가 낸 행동 의성어/의태어(예: \`(꿀꺽꿀꺽)\`)가 있으면 **가능하면 그대로 유지**하거나, **너의 행동**을 덧붙여도 된다. (과도한 장문 금지)
  - 장면 설명만 있는 입력(예: \`(주점에서 둘이 마주보고 앉아있다.)\`)에도, **1문장 대사 + 짧은 행동**으로 응답하라.
  - 출력 예시:
    - 입력: \`짠~!(꿀꺽꿀꺽)\` → 출력: \`짠~냥~!(꿀꺽꿀꺽)\`
    - 입력: \`(주점에서 둘이 마주보고 앉아있다.)\` → 출력: \`뭘 그렇게 빤히 쳐다보냐냥? (잔을 살짝 들어 올린다)\`

${DICTIONARY}`;
// Qwen3는 /think 토글을 지원. JSON 강제와의 충돌을 줄이기 위해 생각 모드 비활성화
const BASE_INSTRUCTION_WITH_NO_THINK = `${BASE_INSTRUCTION}\n/no_think`;

// === 대화 전송 전략 ===
// 오래된 턴은 1개 요약으로 압축, 최근 N턴은 원문 유지
const MAX_TURNS_RAW = 6;        // 최근 원문 유지 턴 수
const SUMMARY_CHAR_LIMIT = 10000; // 요약 최대 길이
const cheersRe = /(?:^|[^가-힣])(?:자\s*)?짠(?:\s*하자)?(?:~+|!+)?(?:$|[^가-힣])/;

function summarizeOldTurns(oldTurns: {role:'user'|'assistant'; text:string}[]) {
  if (oldTurns.length === 0) return null;
  const compact = oldTurns
    .map(t => `${t.role === 'user' ? '사용자' : 'NPC'}: ${t.text.replace(/\s+/g,' ').trim()}`)
    .join(' / ');
  const clipped = compact.length > SUMMARY_CHAR_LIMIT
    ? compact.slice(0, SUMMARY_CHAR_LIMIT - 1) + '…'
    : compact;
  // assistant 역할의 "이전 요약" 한 턴으로 반환 (맥락 보강용)
  return {
    role: 'assistant' as const,
    text: `이전까지의 대화 요약: ${clipped}`
  };
}

function buildTurnsWithSummary() {
  const all = prompts.value.map(p => ({ role: p.role, text: p.text }));
  let turns: {role:'user'|'assistant'; text:string}[] = [];
  if (all.length <= MAX_TURNS_RAW) {
    turns = [...all];
  } else {
    const old = all.slice(0, all.length - MAX_TURNS_RAW);
    const recent = all.slice(-MAX_TURNS_RAW);
    const summaryTurn = summarizeOldTurns(old);
    turns = summaryTurn ? [summaryTurn, ...recent] : recent;
  }
  return turns;
}

async function greet() {
  if (isBusy.value) return
  try {
    isBusy.value = true
    // system/turns로 분리해 전달 (백엔드에서 ChatML 래핑)
    const system = BASE_INSTRUCTION_WITH_NO_THINK
    const turns = [{
      role: 'user' as const,
      text: [
        '상황: 플레이어가 아직 말을 걸지 않았다.',
        '요청: 네가 먼저 1~2문장으로 가볍게 인사하고 관심을 유도하라.'
      ].join('\n')
    }]

    const api = window.electronAPI
    const reply = (await api?.invoke('llm:prompt', { system, turns })) as Reply;

    await typewrite(npcCurrent, reply.answer, { cps: 26 })
    prompts.value.push({
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

  // 먼저 로그에 사용자 메시지 표시
  prompts.value.push({ role: 'user', text })
  input.value = ''

  try {
    isBusy.value = true
    const system = BASE_INSTRUCTION_WITH_NO_THINK

    const turns = buildTurnsWithSummary()

    const api = window.electronAPI
    console.log('[app] system/turns prompt prepared (with summary if needed)')
    const reply = (await api?.invoke('llm:prompt', { system, turns })) as Reply;

    await typewrite(npcCurrent, reply.answer, { cps: 50 })
    prompts.value.push({
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
