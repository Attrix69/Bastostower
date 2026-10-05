import * as THREE from 'three';
import {
  BlendFunction,
  BloomEffect,
  Effect,
  EffectAttribute,
  EffectComposer,
  EffectPass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';

export type QualityLevel = 'low' | 'medium' | 'high';

interface QualityPreset {
  pixelRatioMax: number;
  shadowSize: number;
  bloom: boolean;
  msaa: number;
  softShadows: boolean;
  particleBudget: number;
}

export const QUALITY: Record<QualityLevel, QualityPreset> = {
  low: { pixelRatioMax: 1, shadowSize: 1024, bloom: false, msaa: 0, softShadows: false, particleBudget: 0.5 },
  medium: { pixelRatioMax: 1.25, shadowSize: 2048, bloom: true, msaa: 2, softShadows: true, particleBudget: 0.8 },
  high: { pixelRatioMax: 2, shadowSize: 2048, bloom: true, msaa: 4, softShadows: true, particleBudget: 1 },
};

const GAME_FX_FRAG = /* glsl */ `
uniform float uFlash;
uniform vec3 uFlashColor;
uniform float uSat;
uniform float uDamage;
uniform float uStun;
uniform float uTime;
uniform float uAberration;
uniform float uSpeed;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  vec2 suv = uv;
  if (uStun > 0.001) {
    // drunk wobble
    suv += vec2(sin(uv.y * 9.0 + uTime * 2.7), cos(uv.x * 7.0 + uTime * 2.1)) * 0.0045 * uStun;
    c = texture2D(inputBuffer, suv).rgb;
  }
  vec2 d = uv - 0.5;
  float r2 = dot(d, d);
  float ab = uAberration + uSpeed * 0.6 * r2;
  if (ab > 0.0005) {
    vec2 off = d * ab;
    c.r = texture2D(inputBuffer, suv + off).r;
    c.b = texture2D(inputBuffer, suv - off).b;
  }
  if (uStun > 0.001) {
    vec2 o = vec2(0.010 * sin(uTime * 1.3), 0.004 * cos(uTime * 1.1)) * uStun;
    vec3 ghost = texture2D(inputBuffer, suv + o).rgb;
    c = mix(c, ghost, 0.38 * uStun);
  }
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSat);
  // red pulse on the screen edges when hurt
  float edge = smoothstep(0.08, 0.45, r2);
  c = mix(c, vec3(0.75, 0.02, 0.05), edge * uDamage);
  c += uFlashColor * uFlash;
  outputColor = vec4(c, inputColor.a);
}
`;

/** Screen-space game feedback: flash, desaturation, stun wobble, damage vignette, aberration. */
export class GameFXEffect extends Effect {
  constructor() {
    super('GameFX', GAME_FX_FRAG, {
      attributes: EffectAttribute.CONVOLUTION,
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['uFlash', new THREE.Uniform(0)],
        ['uFlashColor', new THREE.Uniform(new THREE.Color(1, 1, 1))],
        ['uSat', new THREE.Uniform(1)],
        ['uDamage', new THREE.Uniform(0)],
        ['uStun', new THREE.Uniform(0)],
        ['uTime', new THREE.Uniform(0)],
        ['uAberration', new THREE.Uniform(0)],
        ['uSpeed', new THREE.Uniform(0)],
      ]),
    });
  }
  u(name: string) {
    return this.uniforms.get(name)!;
  }
}

/**
 * Owns the WebGL renderer, the post-processing chain, the main camera and the
 * first-person view-model layer (rendered in a 2nd pass on top, depth cleared).
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly vmScene = new THREE.Scene();
  readonly vmCamera: THREE.PerspectiveCamera;
  readonly fx = new GameFXEffect();
  composer!: EffectComposer;
  private bloom: BloomEffect | null = null;
  quality: QualityLevel = 'high';
  /** dynamic resolution factor (0.55..1) */
  private resScale = 1;
  private resTimer = 0;
  private width = 1;
  private height = 1;
  onQualityChanged: ((q: QualityLevel) => void) | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(80, 1, 0.05, 1500);
    this.vmCamera = new THREE.PerspectiveCamera(62, 1, 0.01, 10);
    this.scene.add(this.camera);

    const saved = (localStorage.getItem('bt.quality') as QualityLevel | null) ?? this.guessQuality();
    this.setQuality(saved, false);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  private guessQuality(): QualityLevel {
    const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    const cores = navigator.hardwareConcurrency ?? 4;
    if (mobile || cores <= 2) return 'low';
    if (cores <= 4) return 'medium';
    return 'high';
  }

  get preset() {
    return QUALITY[this.quality];
  }

  setQuality(q: QualityLevel, persist = true) {
    this.quality = q;
    if (persist) {
      try {
        localStorage.setItem('bt.quality', q);
      } catch {
        /* storage may be unavailable */
      }
    }
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.buildComposer();
    this.resScale = 1;
    this.resize();
    this.onQualityChanged?.(q);
  }

  private buildComposer() {
    const p = this.preset;
    this.composer?.dispose();
    this.composer = new EffectComposer(this.renderer, {
      multisampling: p.msaa,
      frameBufferType: THREE.HalfFloatType,
    });
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const vmPass = new RenderPass(this.vmScene, this.vmCamera);
    vmPass.clearPass.color = false;
    vmPass.clearPass.depth = true;
    vmPass.ignoreBackground = true;
    vmPass.skipShadowMapUpdate = true;
    this.composer.addPass(vmPass);

    const effects: Effect[] = [];
    this.bloom = null;
    if (p.bloom) {
      this.bloom = new BloomEffect({
        mipmapBlur: true,
        luminanceThreshold: 0.82,
        luminanceSmoothing: 0.25,
        intensity: 1.15,
        radius: 0.72,
      });
      effects.push(this.bloom);
    }
    effects.push(new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
    this.composer.addPass(new EffectPass(this.camera, ...effects));
    this.composer.addPass(new EffectPass(this.camera, this.fx, new VignetteEffect({ offset: 0.3, darkness: 0.55 })));
  }

  resize() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, this.preset.pixelRatioMax) * this.resScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.width, this.height, false);
    this.composer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.vmCamera.aspect = this.width / this.height;
    this.vmCamera.updateProjectionMatrix();
  }

  /**
   * Dynamic resolution: if frames are consistently slow we lower the internal
   * resolution a notch; if there's headroom we raise it back.
   */
  adaptResolution(frameMs: number, realDt: number) {
    this.resTimer += realDt;
    if (this.resTimer < 1.25) return;
    this.resTimer = 0;
    let next = this.resScale;
    if (frameMs > 19.5) next = Math.max(0.55, this.resScale - 0.1);
    else if (frameMs < 14 && this.resScale < 1) next = Math.min(1, this.resScale + 0.05);
    if (next !== this.resScale) {
      this.resScale = next;
      this.resize();
    }
  }

  render(realDt: number) {
    this.fx.u('uTime').value += realDt;
    this.renderer.info.reset();
    this.composer.render(realDt);
  }
}
