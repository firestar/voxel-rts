import * as THREE from 'three';

export interface RendererOpts {
  /** AI-debug mode: no antialias, fixed 1× pixel ratio, no fog, no
   *  lights. Wireframe materials (set up downstream) ignore lighting
   *  anyway, so dropping the sun + hemi just trims uniforms from
   *  every draw call. */
  debugMode?: boolean;
}

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly sun: THREE.DirectionalLight | null;
  readonly hemi: THREE.HemisphereLight | null;

  constructor(canvas: HTMLCanvasElement, opts: RendererOpts = {}) {
    const debug = !!opts.debugMode;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !debug,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(debug ? 1 : Math.min(devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    if (debug) {
      // Dark slate background reads better behind coloured wireframes
      // than the sky-blue gradient. No fog so wireframes stay crisp
      // out to the horizon.
      this.scene.background = new THREE.Color(0x101418);
      this.sun = null;
      this.hemi = null;
    } else {
      this.scene.background = new THREE.Color(0x88aacc);
      this.scene.fog = new THREE.Fog(0x88aacc, 60, 280);
      this.hemi = new THREE.HemisphereLight(0xddeeff, 0x445566, 0.55);
      this.scene.add(this.hemi);
      this.sun = new THREE.DirectionalLight(0xfff4dd, 1.1);
      this.sun.position.set(60, 90, 40);
      this.scene.add(this.sun);
    }
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
  }

  render(camera: THREE.Camera): void {
    this.renderer.render(this.scene, camera);
  }
}
