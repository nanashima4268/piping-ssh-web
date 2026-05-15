declare var self: Worker;

import {goWasmExportedPromise, GoWasmExported, goWasmExisted} from "@/go-wasm-exported-promise";
import * as Comlink from 'comlink';

// e.g. `(a: number, b: boolean) => string` → `(a: number, b: boolean) => Promise<string>`
type ToAsyncFunction<T extends (...args: any) => any> =
  T extends (...args: infer P) => any
    ? (...args: P) => Promise<Awaited<ReturnType<T>>>
    : never;

// Params for Safari path: uses MessagePorts instead of transferable streams.
// The worker creates local WritableStream/ReadableStream from these ports.
// termPort replaces termReadable to avoid DataCloneError in Safari (ReadableStream is not transferable).
export type PortBasedDoSshParams = {
  sendPort: MessagePort,
  receivePort: MessagePort,
  termPort: MessagePort,
  initialCols: number,
  initialRows: number,
  username: string,
  messagePort: MessagePort,
  authKeySets: Parameters<GoWasmExported["doSsh"]>[0]["authKeySets"],
};

export type GoWasmWorkerObject = {
  [P in keyof GoWasmExported]: ToAsyncFunction<GoWasmExported[P]>
} & {
  existed(): Promise<boolean>,
  doSshViaPort(
    params: PortBasedDoSshParams,
    functions: Parameters<GoWasmExported["doSsh"]>[1],
  ): Promise<void>,
};

const goWasmWorkerObject: GoWasmWorkerObject = {
  async existed(): Promise<boolean> {
    return await goWasmExisted();
  },
  async panicOnPurpose(): Promise<void> {
    const exported = await goWasmExportedPromise;
    await exported.panicOnPurpose();
  },
  async doSsh(params: Parameters<GoWasmExported["doSsh"]>[0], functions: Parameters<GoWasmExported["doSsh"]>[1]): Promise<void> {
    const exported = await goWasmExportedPromise;
    await exported.doSsh(params, functions);
  },
  // Safari fallback: build local streams from MessagePorts so no stream is ever transferred
  async doSshViaPort(params: PortBasedDoSshParams, functions: Parameters<GoWasmExported["doSsh"]>[1]): Promise<void> {
    const exported = await goWasmExportedPromise;

    const writable = new WritableStream<Uint8Array>({
      write(chunk: Uint8Array): void {
        // Transfer ArrayBuffer zero-copy from worker → main thread
        const buf = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
        params.sendPort.postMessage(buf, [buf]);
      },
      close(): void { params.sendPort.postMessage(null); },
      abort(): void { params.sendPort.postMessage(null); },
    });

    const readable = new ReadableStream<Uint8Array>({
      start(ctrl: ReadableStreamDefaultController<Uint8Array>): void {
        params.receivePort.onmessage = ({ data }: MessageEvent<ArrayBuffer | null>) => {
          if (data === null) ctrl.close();
          else ctrl.enqueue(new Uint8Array(data));
        };
      },
    });

    // Reconstruct termReadable from termPort — avoids DataCloneError on Safari
    // (ReadableStream is not transferable in Safari < 16.4)
    const termReadable = new ReadableStream<string>({
      start(ctrl: ReadableStreamDefaultController<string>): void {
        params.termPort.onmessage = ({ data }: MessageEvent<string | null>) => {
          if (data === null) ctrl.close();
          else ctrl.enqueue(data);
        };
      },
    });

    await exported.doSsh({
      transport: { readable, writable },
      termReadable,
      initialCols: params.initialCols,
      initialRows: params.initialRows,
      username: params.username,
      messagePort: params.messagePort,
      authKeySets: params.authKeySets,
    }, functions);
  },
  async getAuthPublicKeyType(publicKey: string): Promise<string> {
    const exported = await goWasmExportedPromise;
    return await exported.getAuthPublicKeyType(publicKey);
  },
  // passphrase is always undefined because x509.EncryptPEMBlock() is deprecated
  async generateRsaKeys(keyBits: number): Promise<{ publicKey: string, privateKey: string }> {
    const exported = await goWasmExportedPromise;
    return exported.generateRsaKeys(keyBits);
  },
  async generateEd25519Keys(): Promise<{ publicKey: string, privateKey: string }> {
    const exported = await goWasmExportedPromise;
    return exported.generateEd25519Keys();
  },
  async sshSha256Fingerprint(publicKey: string): Promise<string> {
    const exported = await goWasmExportedPromise;
    return exported.sshSha256Fingerprint(publicKey);
  },
  async sshPrivateKeyIsEncrypted(privateKey: string): Promise<boolean> {
    const exported = await goWasmExportedPromise;
    return await exported.sshPrivateKeyIsEncrypted(privateKey);
  }
};

Comlink.expose(goWasmWorkerObject);
