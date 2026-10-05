import * as THREE from 'three';
import { brickTexture, concreteTexture, hazardTexture, roofTexture, woodTexture } from './textures';

/** Shared material library — creating materials once keeps shader programs & draw state minimal. */
export class Materials {
  readonly matte = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
  readonly plastic = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0 });
  readonly metal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.75 });
  readonly emissive = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(2.4, 2.4, 2.4) });
  readonly roof: THREE.MeshStandardMaterial;
  readonly concrete: THREE.MeshStandardMaterial;
  readonly brick: THREE.MeshStandardMaterial;
  readonly wood: THREE.MeshStandardMaterial;
  readonly hazard: THREE.MeshStandardMaterial;
  readonly glass = new THREE.MeshStandardMaterial({
    color: 0x5f86a8,
    roughness: 0.04,
    metalness: 0.9,
    transparent: true,
    opacity: 0.55,
  });
  readonly puddle = new THREE.MeshStandardMaterial({
    color: 0x16161c,
    roughness: 0.04,
    metalness: 0.6,
    transparent: true,
    opacity: 0.85,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  constructor() {
    this.roof = new THREE.MeshStandardMaterial({ map: roofTexture(), roughness: 0.95, metalness: 0, vertexColors: true });
    this.concrete = new THREE.MeshStandardMaterial({ map: concreteTexture(), roughness: 0.9, vertexColors: true });
    this.brick = new THREE.MeshStandardMaterial({ map: brickTexture(), roughness: 0.92, vertexColors: true });
    this.wood = new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.8, vertexColors: true });
    this.hazard = new THREE.MeshStandardMaterial({
      map: hazardTexture(),
      roughness: 0.7,
      vertexColors: true,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
  }
}
