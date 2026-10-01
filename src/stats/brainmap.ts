// Every neuron of the brain as an ink dot on paper; a spike darkens it and, for the neurons the game talks to, flashes
// their colour. Seen from behind, so the fly's left is on the left.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ReadyInfo } from "../brain/protocol.ts";

const VERT = /* glsl */ `
  attribute float spikeT;
  attribute float kind;
  uniform float now;
  uniform float px;
  uniform float bgAlpha;
  varying vec4 vColor;
  void main() {
    float a = exp(-max(0.0, now - spikeT) / 160.0);
    vec3 ink = vec3(0.11, 0.10, 0.09);
    vec3 hot = kind > 2.5 ? vec3(0.77, 0.24, 0.17)
             : kind > 1.5 ? vec3(0.78, 0.35, 0.12)
             : kind > 0.5 ? vec3(0.18, 0.42, 0.64)
             : ink;
    float base = kind > 0.5 ? bgAlpha * 4.0 : bgAlpha;
    vColor = vec4(mix(ink, hot, a), base + (0.92 - base) * a);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = px * (1.0 + a * 2.4 * (kind > 0.5 ? 1.5 : 1.0));
  }
`;
const FRAG = /* glsl */ `
  varying vec4 vColor;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = dot(d, d);
    if (r > 0.25) discard;
    gl_FragColor = vec4(vColor.rgb, vColor.a * smoothstep(0.25, 0.1, r));
  }
`;

export class BrainMap {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  readonly material: THREE.ShaderMaterial;
  private readonly spikeT: Float32Array;
  private readonly attr: THREE.BufferAttribute;
  private readonly points: THREE.Points;
  private t0 = performance.now();

  constructor(canvas: HTMLCanvasElement, info: ReadyInfo) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: false });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.camera = new THREE.PerspectiveCamera(30, 1, 1, 10000);
    this.camera.position.set(0, 0, 2100);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableZoom = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 900;
    this.controls.maxDistance = 3500;
    this.controls.enableDamping = true;

    const n = info.neurons;
    const pos = new Float32Array(n * 3);
    // centre, flip y so dorsal is up
    let cx = 0;
    let cy = 0;
    let cz = 0;
    const src = info.anchor;
    for (let i = 0; i < n; i++) {
      cx += src[3 * i];
      cy += src[3 * i + 1];
      cz += src[3 * i + 2];
    }
    cx /= n;
    cy /= n;
    cz /= n;
    for (let i = 0; i < n; i++) {
      pos[3 * i] = src[3 * i] - cx;
      pos[3 * i + 1] = -(src[3 * i + 1] - cy);
      pos[3 * i + 2] = -(src[3 * i + 2] - cz);
    }
    const kind = new Float32Array(n);
    const mark = (ids: Int32Array, k: number) => ids.forEach((i) => (kind[i] = k));
    const g = info.groups;
    mark(g.LC10a_L, 1);
    mark(g.LC10a_R, 1);
    for (const [key, ids] of Object.entries(g)) if (/^DN|^AOTU/.test(key)) mark(ids, 2);
    mark(g.DNp01_L, 3);
    mark(g.DNp01_R, 3);
    mark(g.sugar_GRN_L, 3);
    mark(g.sugar_GRN_R, 3);
    mark(g.proboscis_MN, 3);

    this.spikeT = new Float32Array(n).fill(-1e9);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("kind", new THREE.BufferAttribute(kind, 1));
    this.attr = new THREE.BufferAttribute(this.spikeT, 1);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("spikeT", this.attr);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { now: { value: 0 }, px: { value: 1 }, bgAlpha: { value: 0.05 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.scene.add(this.points);
  }

  /** mark spikes at simulated time (ms) */
  addSpikes(spikes: Int32Array, spikeT: Float32Array, frameStart: number): void {
    for (let k = 0; k < spikes.length; k++) this.spikeT[spikes[k]] = frameStart + spikeT[k];
    this.attr.needsUpdate = true;
  }

  resize(): void {
    const c = this.renderer.domElement;
    const w = Math.max(1, c.clientWidth);
    const h = Math.max(1, c.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // fit the ~900 um wide brain
    const fitW = 1000 / (2 * Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.aspect);
    const fitH = 560 / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.camera.position.setLength(Math.max(fitW, fitH));
    this.camera.updateProjectionMatrix();
    this.material.uniforms.px.value = Math.max(1, Math.min(2.2, h / 180)) * this.renderer.getPixelRatio();
    // the same 138,639 dots on a smaller canvas pile up darker: thin them out
    this.material.uniforms.bgAlpha.value = 0.045 * Math.max(0.3, Math.min(1.2, (w * h) / (520 * 380)));
  }

  render(simNow: number): void {
    this.material.uniforms.now.value = simNow;
    const t = (performance.now() - this.t0) / 1000;
    // gentle sway so the 3D structure reads
    this.points.rotation.y = Math.sin(t * 0.25) * 0.35;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
