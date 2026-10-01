// The fly at an arcade cabinet, lit like a studio shot on paper: its front legs press the ◀ ▶ buttons, the game runs
// on the screen.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { FlyModel } from "./fly.ts";
import { backdropTexture } from "./textures.ts";

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
const BUTTON_X = 0.9;
const BUTTON_Z = -1.2;
const CAP_TOP = 0.27;
const TRAVEL = 0.08;

/** Solid rounded triangle pointing +x, lying flat and raised a little (no decal to z-fight with the cap). */
function arrowGeometry(): THREE.ExtrudeGeometry {
  const pts: [number, number][] = [
    [0.125, 0],
    [-0.075, 0.118],
    [-0.075, -0.118],
  ];
  const r = 0.03;
  const toward = (a: [number, number], b: [number, number], d: number): [number, number] => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [a[0] + ((b[0] - a[0]) * d) / len, a[1] + ((b[1] - a[1]) * d) / len];
  };
  const shape = new THREE.Shape();
  pts.forEach((p, i) => {
    const a = toward(p, pts[(i + 2) % 3], r);
    const b = toward(p, pts[(i + 1) % 3], r);
    if (i === 0) shape.moveTo(a[0], a[1]);
    else shape.lineTo(a[0], a[1]);
    shape.quadraticCurveTo(p[0], p[1], b[0], b[1]);
  });
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.016,
    bevelEnabled: true,
    bevelThickness: 0.008,
    bevelSize: 0.01,
    bevelSegments: 3,
    curveSegments: 8,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(-(pts[0][0] + pts[1][0] + pts[2][0]) / 3, 0, 0);
  return geo;
}

class ArcadeButton {
  readonly group = new THREE.Group();
  private readonly cap: THREE.Group;
  private readonly capMat: THREE.MeshStandardMaterial;
  private readonly light: THREE.PointLight;
  private readonly ring: THREE.MeshStandardMaterial;
  private readonly arrowMat: THREE.MeshStandardMaterial;
  depth = 0;

  constructor(x: number, dir: -1 | 1, color: string) {
    this.group.position.set(x, 0, BUTTON_Z);
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.36, 0.38, 0.08, 40),
      new THREE.MeshStandardMaterial({ color: "#2b2824", roughness: 0.55, metalness: 0.1 }),
    );
    base.position.y = 0.04;
    base.receiveShadow = true;
    this.ring = new THREE.MeshStandardMaterial({ color: "#3a3631", emissive: new THREE.Color(color), emissiveIntensity: 0.05 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.025, 10, 48), this.ring);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.085;
    this.cap = new THREE.Group();
    this.capMat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.25,
      metalness: 0.05,
      emissive: new THREE.Color(color),
      emissiveIntensity: 0.12,
    });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.28, 0.16, 40), this.capMat);
    body.position.y = 0.1;
    body.castShadow = true;
    this.arrowMat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.35, emissive: "#ffffff", emissiveIntensity: 0.25 });
    const arrow = new THREE.Mesh(arrowGeometry(), this.arrowMat);
    arrow.position.y = 0.18;
    arrow.rotation.y = dir < 0 ? Math.PI : 0;
    arrow.castShadow = true;
    this.cap.add(body, arrow);
    this.cap.position.y = CAP_TOP - 0.181;
    this.light = new THREE.PointLight(color, 0, 2.2, 1.6);
    this.light.position.set(0, 0.5, 0);
    this.group.add(base, ring, this.cap, this.light);
  }

  /** p in 0..1: how hard the button is held down */
  set(p: number): void {
    this.depth += (p - this.depth) * 0.35;
    this.cap.position.y = CAP_TOP - 0.181 - TRAVEL * this.depth;
    this.capMat.emissiveIntensity = 0.12 + 0.9 * this.depth;
    this.ring.emissiveIntensity = 0.05 + 0.8 * this.depth;
    this.arrowMat.emissiveIntensity = 0.1 + 0.4 * this.depth;
    this.light.intensity = 1.6 * this.depth;
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
  g.fillStyle = "#2b2824";
  g.fillRect(0, 0, 1024, 160);
  g.font = "italic 500 92px 'Newsreader', Georgia, serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillStyle = "#f3eee4";
  g.fillText("Doodle Fly", 512, 86);
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
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene.background = backdropTexture();
    this.scene.fog = new THREE.Fog("#ebe4d6", 10, 24);

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.05, 60);
    this.camera.position.set(-0.85, 4.45, 3.85);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0.12, 0.62, -0.95);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 2.2;
    this.controls.maxDistance = 9;
    this.controls.maxPolarAngle = 1.5;
    this.controls.autoRotate = false;
    this.controls.update();

    // lights
    this.scene.add(new THREE.HemisphereLight("#ffffff", "#cdbf9f", 1.25));
    const key = new THREE.DirectionalLight("#fff4e6", 2.1);
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
    const rim = new THREE.DirectionalLight("#dfe8ff", 0.7);
    rim.position.set(-3, 2.5, 4);
    this.scene.add(rim);

    // console panel the fly stands on
    const panel = new THREE.Mesh(
      new RoundedBoxGeometry(3.6, 0.4, 2.9, 4, 0.08),
      new THREE.MeshStandardMaterial({ color: "#dcd3c2", roughness: 0.85, metalness: 0 }),
    );
    panel.position.set(0, -0.2, -0.55);
    panel.receiveShadow = true;
    this.scene.add(panel);
    this.left = new ArcadeButton(-BUTTON_X, -1, "#2f6aa3");
    this.right = new ArcadeButton(BUTTON_X, 1, "#c8581e");
    this.scene.add(this.left.group, this.right.group);

    // cabinet with the live game on its screen
    const cabinet = new THREE.Group();
    cabinet.position.set(0, 0, -2.35);
    cabinet.rotation.x = -0.1;
    const shell = new THREE.Mesh(
      new RoundedBoxGeometry(2.9, 3.4, 0.4, 4, 0.1),
      new THREE.MeshStandardMaterial({ color: "#2b2824", roughness: 0.6, metalness: 0.08 }),
    );
    shell.position.y = 1.6;
    shell.castShadow = true;
    shell.receiveShadow = true;
    this.screenTex = new THREE.CanvasTexture(gameCanvas);
    this.screenTex.colorSpace = THREE.SRGBColorSpace;
    this.screenTex.minFilter = THREE.LinearFilter;
    this.screenTex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
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
    this.screenLight = new THREE.PointLight("#fff4e0", 1.6, 5.5, 1.4);
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
