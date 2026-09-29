// Parsers for the packed FlyWire connectome produced by scripts/build_data.py.

export interface BrainMeta {
  version: number;
  dataset: string;
  neurons: number;
  connections: number;
  synapses: number;
  graph: { indptrBytes: number; postBytes: number; weightBytes: number };
  types: string[];
  superclasses: string[];
  classes: string[];
  nts: string[];
  sides: string[];
  groups: Record<string, number[]>;
}

/** CSR adjacency by presynaptic neuron; `syn` is the signed synapse count of each connection. */
export interface BrainGraph {
  n: number;
  indptr: Uint32Array;
  post: Int32Array;
  syn: Int16Array;
}

export interface NeuronInfo {
  type: Uint16Array;
  superclass: Uint8Array;
  cls: Uint8Array;
  side: Uint8Array;
  nt: Uint8Array;
  /** soma positions, micrometres, xyz interleaved */
  soma: Float32Array;
  /** backbone anchor positions, micrometres, xyz interleaved */
  anchor: Float32Array;
}

export const SIDE_LEFT = 1;
export const SIDE_RIGHT = 2;

export function isGzip(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
  return b[0] === 0x1f && b[1] === 0x8b;
}

/** Some servers already strip the gzip layer (Content-Encoding), so only inflate real gzip data. */
export async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  if (!isGzip(buf)) return buf;
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

export function parseGraph(buf: ArrayBuffer, meta: BrainMeta): BrainGraph {
  const n = meta.neurons;
  const e = meta.connections;
  const { indptrBytes, postBytes } = meta.graph;
  const indptr = new Uint32Array(buf.slice(0, indptrBytes));
  const bytes = new Uint8Array(buf);
  const post = new Int32Array(e);
  const syn = new Int16Array(e);

  let at = indptrBytes;
  for (let row = 0; row < n; row++) {
    let prev = 0;
    const end = indptr[row + 1];
    for (let k = indptr[row]; k < end; k++) {
      let x = 0;
      let shift = 0;
      let b: number;
      do {
        b = bytes[at++];
        x |= (b & 0x7f) << shift;
        shift += 7;
      } while (b & 0x80);
      prev += x;
      post[k] = prev;
    }
  }
  if (at !== indptrBytes + postBytes) throw new Error("graph: post section size mismatch");

  for (let k = 0; k < e; k++) {
    let x = 0;
    let shift = 0;
    let b: number;
    do {
      b = bytes[at++];
      x |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    syn[k] = x & 1 ? -((x + 1) >> 1) : x >> 1;
  }
  if (at !== buf.byteLength) throw new Error("graph: weight section size mismatch");
  return { n, indptr, post, syn };
}

export function parseNeurons(buf: ArrayBuffer, n: number): NeuronInfo {
  let at = 0;
  const take = (bytes: number) => {
    const s = buf.slice(at, at + bytes);
    at += bytes;
    return s;
  };
  const info: NeuronInfo = {
    type: new Uint16Array(take(2 * n)),
    superclass: new Uint8Array(take(n)),
    cls: new Uint8Array(take(n)),
    side: new Uint8Array(take(n)),
    nt: new Uint8Array(take(n)),
    soma: new Float32Array(take(12 * n)),
    anchor: new Float32Array(take(12 * n)),
  };
  if (at !== buf.byteLength) throw new Error("neurons: size mismatch");
  return info;
}
