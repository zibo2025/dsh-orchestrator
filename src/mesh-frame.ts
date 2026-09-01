/**
 * The framed-message wire format the sender (agent_send / agent_broadcast)
 * stamps onto every delivered mesh message so the receiver's transcript
 * identifies who the message came from. Single source: the prefix literal
 * below is the contract. It rides the durable user/message event, so frames
 * written by an older build keep parsing under the same prefix.
 */

/** Prefix every delivered mesh message wears so its sender is identifiable. */
export const MESH_MESSAGE_PREFIX = '[orchestrator-mesh] message from agent '

/**
 * Frame a delivered mesh message with its sender's identity — the exact wire
 * format the sender tools (agent_send / agent_broadcast, later agent_schedule)
 * stamp onto every delivery. Character-for-character identical to the private
 * frame() in index.ts so the two share this single implementation.
 */
export function frameMeshMessage(senderId: string, label: string | undefined, message: string): string {
  return MESH_MESSAGE_PREFIX + `${senderId}${label ? ` ("${label}")` : ''}: ${message}`
}
