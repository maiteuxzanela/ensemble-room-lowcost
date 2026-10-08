import { EnsembleRpc } from "./rpc"

export { EnsembleRpc }

/** Minimal structural shape of an RPC registration's event emitter. */
export interface RpcEmitter {
  events: { emit(name: string, data: unknown): Promise<unknown> }
}

/** Publish a member status transition for companions. */
export async function emitMemberEvent(
  registration: RpcEmitter,
  data: { memberName: string; teamId: string; from: string; to: string },
): Promise<void> {
  await registration.events.emit("member", data)
}

/** Publish a toast payload for companions. */
export async function emitNoticeEvent(
  registration: RpcEmitter,
  data: { title?: string; message: string; variant?: string },
): Promise<void> {
  await registration.events.emit("notice", data)
}
