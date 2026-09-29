// Procedural Drosophila melanogaster: faceted red eyes, striped abdomen, veined wings, six IK legs.
// The fly faces -z, y is up, its right side is +x. One unit is roughly one millimetre... times two.
import * as THREE from "three";
import { abdomenTexture, eyeTextures, thoraxTexture, wingTexture } from "./textures.ts";

export interface FlyAnim {
  /** foot targets for the two front legs; null = resting on the floor */
  pressL: THREE.Vector3 | null;
  pressR: THREE.Vector3 | null;
  /** 0..1 how far each front leg has travelled towards its button */
  reachL: number;
  reachR: number;
  proboscis: number;
  startle: number;
  buzz: number;
  /** -1..1 where the head looks */
  lookX: number;
  bob: number;
}

const Y = new THREE.Vector3(0, 1, 0);

class Bone {
  readonly mesh: THREE.Mesh;
  constructor(parent: THREE.Object3D, r0: number, r1: number, mat: THREE.Material) {
    const geo = new THREE.CylinderGeometry(r1, r0, 1, 10, 1);
    geo.translate(0, 0.5, 0);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
    parent.add(this.mesh);
  }
  span(a: THREE.Vector3, b: THREE.Vector3): void {
    const d = b.clone().sub(a);
    const len = d.length();
    this.mesh.position.copy(a);
    this.mesh.quaternion.setFromUnitVectors(Y, d.divideScalar(len || 1));
    this.mesh.scale.set(1, len, 1);
  }
}

interface LegDef {
  hip: THREE.Vector3; // in body space
  coxaDir: THREE.Vector3;
  lens: [number, number, number, number]; // coxa, femur, tibia, tarsus
  foot: THREE.Vector3; // resting foot (fly space)
  tarsusDir: THREE.Vector3;
  side: -1 | 1;
  front: boolean;
}

class Leg {
  readonly def: LegDef;
  private readonly coxa: Bone;
  private readonly femur: Bone;
  private readonly tibia: Bone;
  private readonly tarsus: Bone;
  private readonly knee: THREE.Mesh;
  private readonly ankle: THREE.Mesh;

  constructor(root: THREE.Object3D, def: LegDef, mat: THREE.Material, dark: THREE.Material) {
    this.def = def;
    this.coxa = new Bone(root, 0.075, 0.06, mat);
    this.femur = new Bone(root, 0.06, 0.05, mat);
    this.tibia = new Bone(root, 0.045, 0.035, mat);
    this.tarsus = new Bone(root, 0.032, 0.022, dark);
    const jg = new THREE.SphereGeometry(1, 10, 8);
    this.knee = new THREE.Mesh(jg, dark);
    this.knee.scale.setScalar(0.058);
    this.ankle = new THREE.Mesh(jg, dark);
    this.ankle.scale.setScalar(0.042);
    root.add(this.knee, this.ankle);
  }

  /** place the leg: hip follows the body, foot goes to `foot` with the tarsus along `dir` */
  solve(body: THREE.Object3D, foot: THREE.Vector3, dir: THREE.Vector3): void {
    const d = this.def;
    const [lc, l1, l2, l3] = d.lens;
    const hip = d.hip.clone().applyMatrix4(body.matrix);
    const coxaEnd = hip.clone().add(d.coxaDir.clone().transformDirection(body.matrix).multiplyScalar(lc));
    const ankle = foot.clone().sub(dir.clone().normalize().multiplyScalar(l3));
    // two-bone IK coxaEnd -> knee -> ankle, knee pointing up and outward
    const toAnkle = ankle.clone().sub(coxaEnd);
    let dist = toAnkle.length();
    const axis = toAnkle.divideScalar(dist || 1);
    dist = Math.min(l1 + l2 - 1e-3, Math.max(Math.abs(l1 - l2) + 1e-3, dist));
    const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const pole = new THREE.Vector3(d.side * 0.75, 1, 0);
    pole.sub(axis.clone().multiplyScalar(pole.dot(axis))).normalize();
    const knee = coxaEnd.clone().add(axis.clone().multiplyScalar(a)).add(pole.multiplyScalar(h));
    const ankleFixed = coxaEnd.clone().add(axis.multiplyScalar(dist));
    this.coxa.span(hip, coxaEnd);
    this.femur.span(coxaEnd, knee);
    this.tibia.span(knee, ankleFixed);
    this.tarsus.span(ankleFixed, foot);
    this.knee.position.copy(knee);
    this.ankle.position.copy(ankleFixed);
  }
}

export class FlyModel {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly proboscis = new THREE.Group();
  private readonly rostrum: THREE.Mesh;
  private readonly labellum: THREE.Group;
  private readonly wings: { yaw: THREE.Group; flap: THREE.Group; side: -1 | 1 }[] = [];
  private readonly halteres: THREE.Mesh[] = [];
  private readonly antennae: THREE.Group[] = [];
  private readonly abdomen: THREE.Mesh;
  private readonly legs: Leg[] = [];
  private t = 0;
  private wingPhase = 0;
  private buzz = 0;
  private startle = 0;
  private prob = 0;
  private look = 0;
  private twitch = 0;

  constructor() {
    const cuticle = new THREE.MeshPhysicalMaterial({
      map: thoraxTexture(),
      roughness: 0.55,
      sheen: 0.6,
      sheenColor: new THREE.Color("#f3d9a8"),
      sheenRoughness: 0.5,
    });
    const headMat = new THREE.MeshStandardMaterial({ color: "#c49457", roughness: 0.6 });
    const legMat = new THREE.MeshStandardMaterial({ color: "#9a6c36", roughness: 0.55 });
    const legDark = new THREE.MeshStandardMaterial({ color: "#5e3f1c", roughness: 0.6 });
    const black = new THREE.MeshStandardMaterial({ color: "#1b120a", roughness: 0.4 });
    const eyeTex = eyeTextures();
    eyeTex.map.repeat.set(5, 3);
    eyeTex.bump.repeat.set(5, 3);
    const eyeMat = new THREE.MeshPhysicalMaterial({
      map: eyeTex.map,
      bumpMap: eyeTex.bump,
      bumpScale: 2.5,
      roughness: 0.28,
      clearcoat: 0.6,
      clearcoatRoughness: 0.35,
    });

    this.root.add(this.body);

    // thorax
    const thorax = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), cuticle);
    thorax.scale.set(0.4, 0.37, 0.5);
    thorax.position.set(0, 1.0, 0);
    thorax.rotation.x = 0.15;
    thorax.castShadow = true;
    this.body.add(thorax);
    // scutellum
    const scut = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), cuticle);
    scut.scale.set(0.2, 0.12, 0.16);
    scut.position.set(0, 1.25, 0.36);
    this.body.add(scut);
    // macrochaetae (big bristles) on the scutum
    const bristleGeo = new THREE.ConeGeometry(0.012, 0.34, 5);
    bristleGeo.translate(0, 0.17, 0);
    for (const [x, z, tilt] of [
      [-0.13, -0.18, 0.9],
      [0.13, -0.18, 0.9],
      [-0.22, 0.02, 1.0],
      [0.22, 0.02, 1.0],
      [-0.1, 0.18, 1.2],
      [0.1, 0.18, 1.2],
      [-0.28, -0.1, 0.8],
      [0.28, -0.1, 0.8],
      [-0.08, 0.38, 1.35],
      [0.08, 0.38, 1.35],
    ]) {
      const b = new THREE.Mesh(bristleGeo, black);
      const y = 1.0 + 0.37 * Math.sqrt(Math.max(0, 1 - (x / 0.4) ** 2 - (z / 0.5) ** 2)) - 0.02;
      b.position.set(x, z > 0.3 ? 1.27 : y, z);
      b.rotation.x = tilt;
      b.rotation.z = -x * 1.2;
      this.body.add(b);
    }

    // abdomen: sphere with its poles along z so the tergite bands ring it
    const abGeo = new THREE.SphereGeometry(1, 48, 40);
    abGeo.rotateX(Math.PI / 2);
    this.abdomen = new THREE.Mesh(
      abGeo,
      new THREE.MeshPhysicalMaterial({ map: abdomenTexture(), roughness: 0.5, sheen: 0.4, sheenColor: new THREE.Color("#ffe2b0") }),
    );
    this.abdomen.scale.set(0.34, 0.31, 0.62);
    this.abdomen.position.set(0, 0.9, 0.78);
    this.abdomen.rotation.x = -0.2;
    this.abdomen.castShadow = true;
    this.body.add(this.abdomen);

    // head with compound eyes, ocelli, antennae, proboscis
    this.head.position.set(0, 1.13, -0.55);
    this.body.add(this.head);
    const capsule = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 28), headMat);
    capsule.scale.set(0.29, 0.26, 0.21);
    capsule.castShadow = true;
    this.head.add(capsule);
    for (const side of [-1, 1] as const) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), eyeMat);
      eye.scale.set(0.16, 0.235, 0.2);
      eye.position.set(side * 0.19, 0.01, -0.03);
      eye.rotation.y = side * 0.25;
      eye.castShadow = true;
      this.head.add(eye);
    }
    for (const [x, y, z] of [
      [0, 0.255, 0.02],
      [-0.045, 0.24, 0.07],
      [0.045, 0.24, 0.07],
    ]) {
      const o = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), new THREE.MeshStandardMaterial({ color: "#5a0c08", roughness: 0.3 }));
      o.position.set(x, y, z);
      this.head.add(o);
    }
    for (const side of [-1, 1] as const) {
      const ant = new THREE.Group();
      ant.position.set(side * 0.055, 0.07, -0.19);
      ant.rotation.set(0.5, 0, side * -0.25);
      const seg1 = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 0.07, 8), headMat);
      seg1.position.y = -0.03;
      const seg3 = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshStandardMaterial({ color: "#a8743a", roughness: 0.6 }));
      seg3.scale.set(0.045, 0.07, 0.045);
      seg3.position.y = -0.11;
      ant.add(seg1, seg3);
      // feathery arista
      const arista = new THREE.Group();
      arista.position.set(side * 0.03, -0.1, -0.02);
      arista.rotation.set(-1.0, 0, side * -0.9);
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.008, 0.3, 5), black);
      shaft.position.y = 0.15;
      arista.add(shaft);
      for (let k = 0; k < 7; k++) {
        const hair = new THREE.Mesh(new THREE.CylinderGeometry(0.002, 0.002, 0.07, 3), black);
        hair.position.y = 0.06 + k * 0.035;
        hair.rotation.z = k % 2 ? 0.9 : -0.9;
        arista.add(hair);
      }
      ant.add(arista);
      this.head.add(ant);
      this.antennae.push(ant);
    }
    this.proboscis.position.set(0, -0.17, -0.07);
    this.head.add(this.proboscis);
    const rostGeo = new THREE.CylinderGeometry(0.05, 0.065, 1, 12);
    rostGeo.translate(0, -0.5, 0);
    this.rostrum = new THREE.Mesh(rostGeo, headMat);
    this.rostrum.scale.set(1, 0.08, 1);
    this.proboscis.add(this.rostrum);
    this.labellum = new THREE.Group();
    for (const side of [-1, 1]) {
      const lobe = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshStandardMaterial({ color: "#d0a066", roughness: 0.5 }));
      lobe.scale.set(0.06, 0.05, 0.08);
      lobe.position.set(side * 0.045, 0, 0);
      this.labellum.add(lobe);
    }
    this.proboscis.add(this.labellum);

    // wings
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.bezierCurveTo(-0.16, 0.25, -0.27, 0.8, -0.2, 1.22);
    shape.bezierCurveTo(-0.14, 1.42, 0.12, 1.45, 0.2, 1.25);
    shape.bezierCurveTo(0.26, 1.0, 0.16, 0.4, 0.04, 0.02);
    const wingGeo = new THREE.ShapeGeometry(shape, 24);
    const pos = wingGeo.attributes.position;
    const uv = wingGeo.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getY(i) / 1.45, (pos.getX(i) + 0.28) / 0.56);
    wingGeo.rotateX(Math.PI / 2);
    const wingMat = new THREE.MeshPhysicalMaterial({
      map: wingTexture(),
      transparent: true,
      side: THREE.DoubleSide,
      roughness: 0.15,
      metalness: 0,
      iridescence: 1,
      iridescenceIOR: 1.35,
      iridescenceThicknessRange: [200, 600],
      depthWrite: false,
    });
    for (const side of [-1, 1] as const) {
      const yaw = new THREE.Group();
      yaw.position.set(side * 0.2, 1.3, -0.05);
      const flap = new THREE.Group();
      const mesh = new THREE.Mesh(wingGeo, wingMat);
      mesh.scale.set(side, 1, 1);
      mesh.renderOrder = 2;
      flap.add(mesh);
      yaw.add(flap);
      this.body.add(yaw);
      this.wings.push({ yaw, flap, side });
      // haltere
      const hal = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), new THREE.MeshStandardMaterial({ color: "#d9b27a", roughness: 0.5 }));
      hal.position.set(side * 0.3, 1.02, 0.28);
      this.body.add(hal);
      this.halteres.push(hal);
    }

    // legs: hip in body space, resting foot on the floor (y = 0)
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    for (const side of [-1, 1] as const) {
      const s = side;
      const defs: LegDef[] = [
        { hip: v(0.12 * s, 0.72, -0.3), coxaDir: v(0.3 * s, -1, -0.35).normalize(), lens: [0.2, 0.62, 0.6, 0.42], foot: v(0.45 * s, 0, -0.95), tarsusDir: v(0.2 * s, -0.25, -1).normalize(), side: s, front: true },
        { hip: v(0.17 * s, 0.7, -0.03), coxaDir: v(0.6 * s, -1, 0).normalize(), lens: [0.17, 0.56, 0.62, 0.42], foot: v(0.95 * s, 0, -0.18), tarsusDir: v(s, -0.25, -0.15).normalize(), side: s, front: false },
        { hip: v(0.16 * s, 0.72, 0.2), coxaDir: v(0.5 * s, -1, 0.35).normalize(), lens: [0.18, 0.62, 0.66, 0.46], foot: v(0.78 * s, 0, 0.78), tarsusDir: v(0.55 * s, -0.25, 1).normalize(), side: s, front: false },
      ];
      for (const d of defs) this.legs.push(new Leg(this.root, d, legMat, legDark));
    }
  }

  update(dt: number, a: FlyAnim): void {
    this.t += dt;
    const k = (tau: number) => 1 - Math.exp(-dt / tau);
    this.buzz += (a.buzz - this.buzz) * k(0.08);
    this.startle += (a.startle - this.startle) * k(0.05);
    this.prob += (a.proboscis - this.prob) * k(0.12);
    this.look += (a.lookX - this.look) * k(0.15);

    // body: breathing, bob on jumps, flinch on giant-fibre spikes, lean towards the pressing leg
    const lean = (a.reachR - a.reachL) * 0.06;
    this.body.position.y = 0.02 * Math.sin(this.t * 2.2) + a.bob * 0.05 + this.startle * 0.18;
    this.body.rotation.z = -lean;
    this.body.rotation.x = -0.05 * (a.reachL + a.reachR) - this.startle * 0.12;
    this.body.updateMatrix();
    this.abdomen.scale.set(0.34 * (1 + 0.015 * Math.sin(this.t * 3)), 0.31, 0.62);

    this.head.rotation.y = -this.look * 0.3;
    this.head.rotation.x = 0.12 + 0.12 * (a.reachL + a.reachR) * 0.5;
    if (Math.random() < dt * 0.8) this.twitch = 1;
    this.twitch *= Math.exp(-dt * 6);
    this.antennae.forEach((ant, i) => {
      ant.rotation.x = 0.5 + 0.12 * this.twitch * (i ? 1 : -1) + 0.04 * Math.sin(this.t * 5 + i);
    });

    // proboscis extends with proboscis-motor-neuron activity
    this.rostrum.scale.y = 0.08 + 0.55 * this.prob;
    this.labellum.position.y = -(0.08 + 0.55 * this.prob);
    this.proboscis.rotation.x = -0.25 * this.prob;

    // wings: folded at rest, spread and beating when buzzing; flared by the giant fibre
    this.wingPhase += dt * (8 + 90 * this.buzz);
    const spread = Math.min(1, this.buzz * 1.4);
    for (const w of this.wings) {
      const yaw = 0.26 + 1.25 * spread + 0.25 * this.startle;
      w.yaw.rotation.y = w.side * yaw;
      const stroke = this.buzz * 0.9 * Math.sin(this.wingPhase);
      w.flap.rotation.x = -(0.08 + 0.7 * this.startle + 0.25 * spread) - stroke;
    }
    this.halteres.forEach((h, i) => (h.position.y = 1.02 + (this.buzz > 0.1 ? 0.05 * Math.sin(this.wingPhase + i * Math.PI) : 0)));

    // legs
    for (const leg of this.legs) {
      const d = leg.def;
      let foot = d.foot.clone();
      let dir = d.tarsusDir.clone();
      if (d.front) {
        const target = d.side < 0 ? a.pressL : a.pressR;
        const p = d.side < 0 ? a.reachL : a.reachR;
        if (target && p > 0) {
          const e = p * p * (3 - 2 * p);
          foot = d.foot.clone().lerp(target, e);
          foot.y += Math.sin(Math.PI * Math.min(1, p * 1.15)) * 0.28 * (1 - e * 0.6);
          dir = d.tarsusDir.clone().lerp(new THREE.Vector3(0.05 * d.side, -0.6, -1).normalize(), e).normalize();
        }
      } else {
        // middle and hind legs brace a little when the body leans or flinches
        foot.x += d.side * this.startle * 0.12;
      }
      leg.solve(this.body, foot, dir);
    }
  }
}
