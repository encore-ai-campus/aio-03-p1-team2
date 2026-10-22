// Keep the event reference separate from the opinion while editing existing feedback.
export function splitEventFeedback(content = '') {
  const match =
    /^(\[대상 이벤트\]\r?\n이벤트 ID: [^\r\n]+\r?\n(?:감지 시각: [^\r\n]+\r?\n)?\r?\n\[사용자 의견\]\r?\n)/.exec(
      content,
    )
  return match
    ? { context: match[1], opinion: content.slice(match[1].length) }
    : { context: '', opinion: content }
}
