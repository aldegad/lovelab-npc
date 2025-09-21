// ========= 타이핑 유틸 =========
import { ref } from 'vue'

// 진행 중 타이핑을 취소하기 위한 토큰
const typingToken = ref<AbortController | null>(null)

/** 문자열을 "문자(그래페임) 단위" 배열로 분해 (한글/이모지 안전) */
function splitGraphemes(text: string): string[] {
  try {
    // 브라우저가 지원하면 가장 안전
    const seg = new Intl.Segmenter('ko', { granularity: 'grapheme' })
    return Array.from(seg.segment(text), s => s.segment)
  } catch {
    // 폴백: 대부분의 케이스에서 잘 동작
    return Array.from(text)
  }
}

/**
 * 한 글자씩 타이핑해서 target.value에 출력
 * @param target  ref<string> (예: npcCurrent)
 * @param full    최종 텍스트
 * @param opt     { cps?: number, onProgress?: (i)=>void }
 * @returns skip() 즉시 완료하는 함수
 */
export async function typewrite(
  target: { value: string },
  full: string,
  opt: { cps?: number; onProgress?: (i: number) => void } = {}
) {
  // 이전 타이핑이 있으면 취소
  if (typingToken.value) typingToken.value.abort()
  const ac = new AbortController()
  typingToken.value = ac

  const cps = Math.max(5, opt.cps ?? 25) // 초당 글자 수
  const baseDelay = 1000 / cps

  const chars = splitGraphemes(full)
  target.value = ''

  // 즉시 모두 표시용 함수
  const skip = () => {
    if (!ac.signal.aborted) ac.abort() // 루프 중지
    target.value = full
  }

  const pauseMap: Record<string, number> = {
    ',': 100, '、': 100, '，': 120,
    '.': 160, '。': 160, '!': 160, '?': 160,
    '…': 220, '—': 180, ':': 120, ';': 120
  }

  for (let i = 0; i < chars.length; i++) {
    if (ac.signal.aborted) break
    target.value += chars[i]
    opt.onProgress?.(i)

    // 기본 딜레이
    let wait = baseDelay

    // 문장부호에서 살짝 멈춤
    const ch = chars[i]
    if (ch && pauseMap[ch] != null) wait += pauseMap[ch]

    // 연속 점/말줄임표 처리(예: "..." or "…")
    if (ch === '.' && i + 1 < chars.length && chars[i + 1] === '.') wait += 80

    await new Promise(r => setTimeout(r, wait))
  }

  typingToken.value = null
  return skip
}
