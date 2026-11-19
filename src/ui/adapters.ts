// Studio implementations of @glslop/ui's host adapters.
import type { Studio } from '../studio/api';

export function exportAdapters(studio: Studio) {
  return {
    where: 'on your gpu, into workspace/exports',
    async save(blob: Blob, filename: string) {
      const path = `${studio.host.paths.workspace}/exports/${filename}`;
      await studio.host.writeBytes(path, new Uint8Array(await blob.arrayBuffer()));
      studio.events.emit('export:saved', { path });
      return path;
    },
    onStart: () => studio.events.emit('export:start'),
    onEnd: () => studio.events.emit('export:end'),
    reveal: (path: string) => studio.host.open(path),
  };
}
