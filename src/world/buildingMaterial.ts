import * as THREE from 'three';

/**
 * Facade material with procedurally lit windows, computed in the fragment
 * shader from world position. One material + instancing = an entire city
 * skyline in a handful of draw calls, with zero textures.
 */
export function createBuildingMaterial(opts: { litRatio?: number; windowW?: number; floorH?: number } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.05 });
  const litThreshold = 1 - (opts.litRatio ?? 0.38);
  const ww = (opts.windowW ?? 2.8).toFixed(2);
  const fh = (opts.floorH ?? 3.4).toFixed(2);
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vBtWPos;
        varying vec3 vBtWN;
        varying float vBtSeed;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 btWp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          btWp = instanceMatrix * btWp;
          vBtSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
        #else
          vBtSeed = 0.37;
        #endif
        btWp = modelMatrix * btWp;
        vBtWPos = btWp.xyz;
        vBtWN = objectNormal;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vBtWPos;
        varying vec3 vBtWN;
        varying float vBtSeed;
        float btHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 an = abs(vBtWN);
          if (an.y < 0.5) {
            vec2 fuv = an.x > 0.5 ? vBtWPos.zy : vBtWPos.xy;
            vec2 cell = fuv / vec2(${ww}, ${fh});
            vec2 id = floor(cell);
            vec2 f = fract(cell);
            float win = step(0.16, f.x) * step(f.x, 0.84) * step(0.22, f.y) * step(f.y, 0.82);
            float h = btHash(id + vBtSeed * 91.7 + floor(vBtWN.xz * 3.0));
            float lit = step(${litThreshold.toFixed(3)}, h);
            // whole floors switched off sometimes
            lit *= step(0.18, btHash(vec2(id.y, vBtSeed * 13.0)));
            vec3 warm = vec3(1.0, 0.72, 0.38);
            vec3 cool = vec3(0.55, 0.78, 1.0);
            vec3 tv = vec3(0.6, 0.65, 1.0);
            float k = fract(h * 7.31);
            vec3 wc = k < 0.62 ? warm : (k < 0.9 ? cool : tv);
            float flick = 0.75 + 0.25 * fract(h * 3.7);
            // distant facades: blend the window grid to its average to avoid shimmering
            float camDist = length(vBtWPos - cameraPosition);
            float far = smoothstep(120.0, 420.0, camDist);
            float avgLit = ${(1 - litThreshold).toFixed(3)} * 0.42;
            vec3 avgCol = vec3(1.0, 0.78, 0.5);
            diffuseColor.rgb = mix(mix(diffuseColor.rgb, vec3(0.04, 0.05, 0.08), win * 0.85), diffuseColor.rgb * 0.55, far);
            totalEmissiveRadiance += mix(win * lit * wc * 1.9 * flick, avgCol * avgLit * 1.9, far);
            // subtle floor bands
            diffuseColor.rgb *= 0.92 + 0.08 * step(0.08, f.y);
          }
        }`,
      );
  };
  mat.customProgramCacheKey = () => `bt-building-${litThreshold}-${ww}-${fh}`;
  return mat;
}
