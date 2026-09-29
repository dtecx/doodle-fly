// The fly at an arcade cabinet: its front legs press the ◀ ▶ buttons, the game runs on the screen.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { FlyModel } from "./fly.ts";
import { arrowTexture, backdropTexture } from "./textures.ts";

export interface ArcadeState {
  /** decoded steering, -1 (left) .. 1 (right) */
  steer: number;
  proboscis: number;
  startle: number;
  buzz: number;
  /** a bounce just happened */
  bounce: boolean;
}

const PRESS_ON = 0.1;
const BUTTON_X = 0.6;
const BUTTON_Z = -1.3;
const CAP_TOP = 0.27;
const TRAVEL = 0.08;

class ArcadeButton {
  readonly group = new THREE.Group();
  private readonly cap: THREE.Group;
  private readonly capMat: THREE.MeshStandardMaterial;
  private readonly light: THREE.PointLight;
  private readonly ring: THREE.MeshStandardMaterial;
  depth = 0;

  constructor(x: number, dir: -1 | 1, color: string) {
    this.group.position.set(x, 0, BUTTON_Z);
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.36, 0.38, 0.08, 40),
      new THREE.MeshStandardMaterial({ color: "#111320", roughness: 0.4, metalness: 0.3 }),
    );
    base.position.y = 0.04;
    base.receiveShadow = true;
    this.ring = new THREE.MeshStandardMaterial({ color: "#202438", emissive: new THREE.Color(color), emissiveIntensity: 0.15 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.025, 10, 48), this.ring);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.085;
    this.cap = new THREE.Group();
    this.capMat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.25,
      metalness: 0.05,
      emissive: new THREE.Color(color),
      emissiveIntensity: 0.25,
    });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.28, 0.16, 40), this.capMat);
    body.position.y = 0.1;
    body.castShadow = true;
    const top = new THREE.Mesh(
      new THREE.CircleGeometry(0.27, 40),
      new THREE.MeshStandardMaterial({ map: arrowTexture(dir, color), roughness: 0.3, emissive: "#ffffff", emissiveMap: arrowTexture(dir, color), emissiveIntensity: 0.2 }),
    );
    top.rotation.x = -Math.PI / 2;
    top.position.y = 0.181;
    this.cap.add(body, top);
    this.cap.position.y = CAP_TOP - 0.181;
    this.light = new THREE.PointLight(color, 0, 2.2, 1.6);
    this.light.position.set(0, 0.5, 0);
    this.group.add(base, ring, this.cap, this.light);
  }

  /** p in 0..1: how hard the button is held down */
  set(p: number): void {
    this.depth += (p - this.depth) * 0.35;
    this.cap.position.y = CAP_TOP - 0.181 - TRAVEL * this.depth;
    this.capMat.emissiveIntensity = 0.25 + 2.4 * this.depth;
    this.ring.emissiveIntensity = 0.15 + 1.5 * this.depth;
    this.light.intensity = 3.5 * this.depth;
  }

  get top(): THREE.Vector3 {
    return new THREE.Vector3(this.group.position.x, CAP_TOP - TRAVEL * this.depth, this.group.position.z);
  }
}

function marqueeTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 160;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 1024, 0);
  grad.addColorStop(0, "#ff3d81");
  grad.addColorStop(0.5, "#ffb13d");
  grad.addColorStop(1, "#3dd6ff");
  g.fillStyle = "#0b0d1a";
  g.fillRect(0, 0, 1024, 160);
  g.font = "96px 'Pangolin', 'Comic Sans MS', cursive";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.shadowColor = "#ff9d3d";
  g.shadowBlur = 24;
  g.fillStyle = grad;
  g.fillText("DOODLE FLY", 512, 84);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ArcadeScene {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly fly = new FlyModel();
  private readonly left: ArcadeButton;
  private readonly right: ArcadeButton;
  private readonly screenTex: THREE.CanvasTexture;
  private readonly screen: THREE.Mesh;
  private readonly screenLight: THREE.PointLight;
  private reachL = 0;
  private reachR = 0;
  private bob = 0;
  private look = 0;

  constructor(canvas: HTMLCanvasElement, gameCanvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.background = backdropTexture();
    this.scene.fog = new THREE.Fog("#070913", 9, 20);

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.05, 60);
    this.camera.position.set(2.2, 2.55, 4.6);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 1.05, -1.0);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 2.2;
    this.controls.maxDistance = 9;
    this.controls.maxPolarAngle = 1.5;
    this.controls.autoRotate = false;
    this.controls.update();

    // lights
    this.scene.add(new THREE.HemisphereLight("#a9c1ff", "#1b1209", 0.55));
    const key = new THREE.DirectionalLight("#fff0dc", 2.4);
    key.position.set(2.8, 5.5, 3.2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -3;
    key.shadow.camera.right = 3;
    key.shadow.camera.top = 3;
    key.shadow.camera.bottom = -3;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight("#7fb2ff", 1.3);
    rim.position.set(-3, 2.5, 4);
    this.scene.add(rim);

    // console panel the fly stands on
    const panel = new THREE.Mesh(
      new RoundedBoxGeometry(3.6, 0.4, 2.9, 4, 0.08),
      new THREE.MeshStandardMaterial({ color: "#1a1e36", roughness: 0.55, metalness: 0.25 }),
    );
    panel.position.set(0, -0.2, -0.55);
    panel.receiveShadow = true;
    this.scene.add(panel);
    for (const [x, color] of [
      [-1.8, "#3dd6ff"],
      [1.8, "#ff3d81"],
    ] as const) {
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(0.03, 0.03, 2.8),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2 }),
      );
      strip.position.set(x, 0.0, -0.55);
      this.scene.add(strip);
    }
    const front = new THREE.Mesh(
      new THREE.BoxGeometry(3.5, 0.03, 0.03),
      new THREE.MeshStandardMaterial({ color: "#ffb13d", emissive: "#ffb13d", emissiveIntensity: 1.6 }),
    );
    front.position.set(0, 0.0, 0.9);
    this.scene.add(front);

    this.left = new ArcadeButton(-BUTTON_X, -1, "#2ea8ff");
    this.right = new ArcadeButton(BUTTON_X, 1, "#ff7a1a");
    this.scene.add(this.left.group, this.right.group);

    // cabinet with the live game on its screen
    const cabinet = new THREE.Group();
    cabinet.position.set(0, 0, -2.35);
    cabinet.rotation.x = -0.1;
    const shell = new THREE.Mesh(
      new RoundedBoxGeometry(2.9, 3.4, 0.4, 4, 0.1),
      new THREE.MeshStandardMaterial({ color: "#12152a", roughness: 0.5, metalness: 0.3 }),
    );
    shell.position.y = 1.6;
    shell.castShadow = true;
    shell.receiveShadow = true;
    this.screenTex = new THREE.CanvasTexture(gameCanvas);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    this.screenTex.minFilter = THREE.LinearFilter;
    this.screen = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.screenTex, toneMapped: false }),
    );
    this.screen.position.set(0, 1.5, 0.205);
    const marquee = new THREE.Mesh(
      new THREE.PlaneGeometry(2.5, 0.39),
      new THREE.MeshBasicMaterial({ map: marqueeTexture(), toneMapped: false }),
    );
    marquee.position.set(0, 3.07, 0.205);
    cabinet.add(shell, this.screen, marquee);
    this.scene.add(cabinet);
    this.screenLight = new THREE.PointLight("#bfe0ff", 5, 5.5, 1.4);
    this.screenLight.position.set(0, 1.6, -1.8);
    this.scene.add(this.screenLight);

    this.fly.root.position.set(0, 0, 0.1);
    this.scene.add(this.fly.root);
    this.fly.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
  }

  resize(): void {
    const c = this.renderer.domElement;
    const w = Math.max(1, c.clientWidth);
    const h = Math.max(1, c.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** match the screen to the game canvas aspect */
  setScreenAspect(aspect: number): void {
    const h = 2.9;
    const w = Math.min(2.55, h * aspect);
    this.screen.scale.set(w, w / aspect, 1);
  }

  render(dt: number, s: ArcadeState): void {
    const wantL = s.steer < -PRESS_ON ? Math.min(1, (-s.steer - PRESS_ON) / 0.35 + 0.35) : 0;
    const wantR = s.steer > PRESS_ON ? Math.min(1, (s.steer - PRESS_ON) / 0.35 + 0.35) : 0;
    const k = 1 - Math.exp(-dt / 0.06);
    this.reachL += ((wantL > 0 ? 1 : 0) - this.reachL) * k;
    this.reachR += ((wantR > 0 ? 1 : 0) - this.reachR) * k;
    // the cap goes down only once the foot is on it
    this.left.set(this.reachL > 0.85 ? wantL : 0);
    this.right.set(this.reachR > 0.85 ? wantR : 0);
    if (s.bounce) this.bob = 1;
    this.bob *= Math.exp(-dt * 7);
    this.look += (Math.max(-1, Math.min(1, s.steer)) - this.look) * (1 - Math.exp(-dt / 0.2));

    this.fly.root.updateMatrixWorld();
    const pad = (b: ArcadeButton) => this.fly.root.worldToLocal(b.top.add(new THREE.Vector3(0, 0.005, 0.1)));
    this.fly.update(dt, {
      pressL: pad(this.left),
      pressR: pad(this.right),
      reachL: this.reachL,
      reachR: this.reachR,
      proboscis: s.proboscis,
      startle: s.startle,
      buzz: s.buzz,
      lookX: this.look,
      bob: this.bob,
    });
    this.screenTex.needsUpdate = true;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
