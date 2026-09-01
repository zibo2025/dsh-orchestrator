/** Clip one text value to the character cap, marking the cut. */
export function clip(text: string, cap: number): string {
  return text.length <= cap ? text : text.slice(0, cap - 1) + '…'
}
