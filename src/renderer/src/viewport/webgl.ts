import type { SourceScene, SourceMesh } from '../../../shared/scene';
import type { EvaluatedMesh } from '../../../core/model/evaluate';
import type { AlphaTexture } from './picking';

const vertexSource = `#version 300 es
in vec2 a_position;
in vec2 a_uv;
in vec4 a_color;
uniform vec4 u_transform;
out vec2 v_uv;
out vec4 v_color;
void main() {
  gl_Position=vec4(a_position*u_transform.xy+u_transform.zw,0.0,1.0);
  v_uv=a_uv;
  v_color=a_color;
}`;
const fragmentSource = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform sampler2D u_mask;
uniform vec2 u_size;
uniform float u_opacity;
uniform vec4 u_multiply;
uniform vec4 u_screen;
uniform int u_clip;
uniform bool u_maskPass;
in vec2 v_uv;
in vec4 v_color;
out vec4 outColor;
void main() {
  // WebGL has no CLAMP_TO_BORDER. Match a transparent texel border, including
  // its half-texel linear-filter footprint, for both model images and atlases.
  vec2 size=vec2(textureSize(u_texture,0));
  vec2 edge=clamp(v_uv*size+0.5,0.0,1.0)*clamp((1.0-v_uv)*size+0.5,0.0,1.0);
  float border=edge.x*edge.y;
  if(border<=0.0) discard;
  vec4 texel=texture(u_texture,v_uv);
  float alpha=texel.a*u_opacity*border*v_color.a;
  if(u_maskPass) { outColor=vec4(alpha); return; }
  vec3 color=(texel.a>0.0?texel.rgb/texel.a:vec3(0.0))*u_multiply.rgb*v_color.rgb;
  color=color+u_screen.rgb-color*u_screen.rgb;
  if(u_clip!=0) {
    float mask=texture(u_mask,gl_FragCoord.xy/u_size).a;
    alpha*=u_clip==2?1.0-mask:mask;
  }
  outColor=vec4(color*alpha,alpha);
}`;
interface MeshBuffers {
  vao: WebGLVertexArrayObject;
  positions: WebGLBuffer;
  uv: WebGLBuffer;
  indices: WebGLBuffer;
  count: number;
  uvs: number[];
  triangles: number[];
  pose: Float32Array | null;
  colors: WebGLBuffer | null;
  colorPose: Float32Array | null;
}
const equalArray = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
interface TextureResource {
  texture: WebGLTexture;
  alpha: AlphaTexture;
}

/** Lattice's texture/triangle renderer. All model evaluation happens in TS. */
export class MeshRenderer {
  readonly alphas: AlphaTexture[] = [];
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly colorAttribute: number;
  private readonly uniforms: Record<string, WebGLUniformLocation> = {};
  private readonly buffers = new Map<string, MeshBuffers>();
  private readonly textures: WebGLTexture[] = [];
  private textureResources = new Map<string, TextureResource>();
  private readonly maskTexture: WebGLTexture;
  private readonly emptyMask: WebGLTexture;
  private readonly maskBuffer: WebGLFramebuffer;
  private size = { width: 0, height: 0 };
  private disposed = false;
  private meshes: EvaluatedMesh[] = [];
  private byGuid = new Map<string, EvaluatedMesh>();
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly fail: (message: string) => void,
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL 2 is unavailable.');
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', this.contextLost);
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const error = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Shader compilation failed: ${error}`);
      }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, vertexSource),
      fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    gl.linkProgram(this.program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS))
      throw new Error(`Shader linking failed: ${gl.getProgramInfoLog(this.program)}`);
    this.colorAttribute = gl.getAttribLocation(this.program, 'a_color');
    for (const name of [
      'transform',
      'texture',
      'mask',
      'size',
      'opacity',
      'multiply',
      'screen',
      'clip',
      'maskPass',
    ]) {
      const location = gl.getUniformLocation(this.program, `u_${name}`);
      if (location === null) throw new Error(`Shader uniform missing: ${name}`);
      this.uniforms[name] = location;
    }
    this.maskTexture = this.createTexture();
    this.emptyMask = this.createTexture();
    this.maskBuffer = gl.createFramebuffer()!;
    gl.bindTexture(gl.TEXTURE_2D, this.emptyMask);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]),
    );
  }
  private contextLost = (event: Event) => {
    event.preventDefault();
    this.fail('WebGL context was lost. Reopen the project to reload the preview.');
  };
  private createTexture() {
    const gl = this.gl,
      texture = gl.createTexture();
    if (!texture) throw new Error('Could not allocate a texture.');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  }
  async load(scene: SourceScene, signal: AbortSignal) {
    const gl = this.gl,
      maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const resources = new Map<string, TextureResource>();
    const created: WebGLTexture[] = [];
    let committed = false;
    try {
      for (const image of scene.textures) {
        const cached = resources.get(image.url) || this.textureResources.get(image.url);
        if (cached) {
          if (cached.alpha.width !== image.width || cached.alpha.height !== image.height)
            throw new Error('Source image dimensions do not match.');
          resources.set(image.url, cached);
          continue;
        }
        if (image.width > maxTextureSize || image.height > maxTextureSize)
          throw new Error(`Source image exceeds the GPU texture limit (${maxTextureSize}).`);
        const response = await fetch(image.url, { signal });
        if (!response.ok) throw new Error('Could not read a source image.');
        const bitmap = await createImageBitmap(await response.blob(), {
          // Filtering straight RGB mixes invisible pixels into visible edges.
          // Upload premultiplied pixels so atlas padding preserves edge colors.
          premultiplyAlpha: 'premultiply',
          colorSpaceConversion: 'none',
        });
        try {
          signal.throwIfAborted();
          if (this.disposed) return;
          if (bitmap.width !== image.width || bitmap.height !== image.height)
            throw new Error('Source image dimensions do not match.');
          const surface = new OffscreenCanvas(bitmap.width, bitmap.height),
            context = surface.getContext('2d', { willReadFrequently: true })!;
          context.drawImage(bitmap, 0, 0);
          const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data,
            alpha = new Uint8Array(bitmap.width * bitmap.height);
          for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3];
          const texture = this.createTexture();
          created.push(texture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
          resources.set(image.url, {
            texture,
            alpha: { width: bitmap.width, height: bitmap.height, alpha },
          });
        } finally {
          bitmap.close();
        }
      }
      signal.throwIfAborted();
      if (this.disposed) return;
      // Commit after every new image is ready. A canceled refresh leaves the
      // previous scene and its textures usable while the next edit loads.
      this.updateTopology(scene.meshes);
      const guids = new Set(scene.meshes.map((mesh) => mesh.guid));
      for (const [guid, buffer] of this.buffers)
        if (!guids.has(guid)) {
          this.deleteBuffers(buffer);
          this.buffers.delete(guid);
        }
      for (const [url, resource] of this.textureResources)
        if (!resources.has(url)) gl.deleteTexture(resource.texture);
      this.textureResources = resources;
      this.textures.splice(
        0,
        this.textures.length,
        ...scene.textures.map((image) => resources.get(image.url)!.texture),
      );
      this.alphas.splice(
        0,
        this.alphas.length,
        ...scene.textures.map((image) => resources.get(image.url)!.alpha),
      );
      gl.bindVertexArray(null);
      committed = true;
    } finally {
      if (!committed) for (const texture of created) gl.deleteTexture(texture);
    }
  }
  private updateTopology(meshes: SourceMesh[]) {
    const gl = this.gl;
    for (const mesh of meshes) {
      const old = this.buffers.get(mesh.guid);
      if (old && equalArray(old.uvs, mesh.uvs) && equalArray(old.triangles, mesh.indices)) continue;
      const vao = gl.createVertexArray()!,
        positions = gl.createBuffer()!,
        uv = gl.createBuffer()!,
        indices = gl.createBuffer()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, positions);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs.length * 4, gl.DYNAMIC_DRAW);
      const posLocation = gl.getAttribLocation(this.program, 'a_position');
      gl.enableVertexAttribArray(posLocation);
      gl.vertexAttribPointer(posLocation, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, uv);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.uvs), gl.STATIC_DRAW);
      const uvLocation = gl.getAttribLocation(this.program, 'a_uv');
      gl.enableVertexAttribArray(uvLocation);
      gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, 0, 0);
      const colorLocation = this.colorAttribute,
        colors = mesh.path ? gl.createBuffer()! : null;
      if (colors) {
        gl.bindBuffer(gl.ARRAY_BUFFER, colors);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          new Float32Array(mesh.uvs.length * 2).fill(1),
          gl.DYNAMIC_DRAW,
        );
        gl.enableVertexAttribArray(colorLocation);
        gl.vertexAttribPointer(colorLocation, 4, gl.FLOAT, false, 0, 0);
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(mesh.indices), gl.STATIC_DRAW);
      this.buffers.set(mesh.guid, {
        vao,
        positions,
        uv,
        indices,
        count: mesh.indices.length,
        uvs: mesh.uvs,
        triangles: mesh.indices,
        pose: null,
        colors,
        colorPose: null,
      });
      if (old) this.deleteBuffers(old);
    }
    gl.bindVertexArray(null);
  }
  setPose(meshes: EvaluatedMesh[]) {
    if (this.disposed) return;
    this.updateTopology(meshes.map((mesh) => mesh.source));
    this.meshes = meshes;
    this.byGuid = new Map(meshes.map((mesh) => [mesh.source.guid, mesh]));
    const gl = this.gl;
    for (const mesh of meshes) {
      const buffer = this.buffers.get(mesh.source.guid)!;
      if (
        buffer.colors &&
        mesh.vertexColors &&
        (!buffer.colorPose || !equalArray(buffer.colorPose, mesh.vertexColors))
      ) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer.colors);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, mesh.vertexColors);
        buffer.colorPose = mesh.vertexColors.slice();
      }
      if (buffer.pose && equalArray(buffer.pose, mesh.positions)) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer.positions);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, mesh.positions);
      buffer.pose = mesh.positions.slice();
    }
  }
  draw(transform: [number, number, number, number]) {
    if (this.disposed) return;
    const gl = this.gl,
      width = this.canvas.width,
      height = this.canvas.height;
    if (width !== this.size.width || height !== this.size.height) {
      this.size = { width, height };
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskBuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.maskTexture,
        0,
      );
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error('Could not allocate the clipping mask buffer.');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.useProgram(this.program);
    gl.uniform4fv(this.uniforms.transform, transform);
    gl.uniform2f(this.uniforms.size, width, height);
    gl.uniform1i(this.uniforms.texture, 0);
    gl.uniform1i(this.uniforms.mask, 1);
    const draw = (mesh: EvaluatedMesh, mask: boolean) => {
      const buffer = this.buffers.get(mesh.source.guid)!;
      gl.bindVertexArray(buffer.vao);
      if (!buffer.colors) gl.vertexAttrib4f(this.colorAttribute, 1, 1, 1, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[mesh.source.texture]);
      if (mesh.source.culling) {
        gl.enable(gl.CULL_FACE);
        gl.frontFace(gl.CW);
      } else gl.disable(gl.CULL_FACE);
      gl.uniform1f(this.uniforms.opacity, mesh.opacity);
      gl.uniform4fv(this.uniforms.multiply, mesh.multiply);
      gl.uniform4fv(this.uniforms.screen, mesh.screen);
      gl.uniform1i(this.uniforms.maskPass, Number(mask));
      gl.drawElements(gl.TRIANGLES, buffer.count, gl.UNSIGNED_INT, 0);
    };
    let lastMask = '';
    for (const mesh of this.meshes) {
      if (!mesh.visible || mesh.opacity <= 0) continue;
      const clips = mesh.source.clips;
      if (clips.length) {
        const key = clips.join(',');
        if (key !== lastMask) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskBuffer);
          // The draw framebuffer must never also be bound for sampling.
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, this.emptyMask);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.uniform1i(this.uniforms.clip, 0);
          for (const guid of clips) {
            const mask = this.byGuid.get(guid);
            if (mask?.visible && mask.opacity > 0) draw(mask, true);
          }
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          lastMask = key;
        }
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
        gl.uniform1i(this.uniforms.clip, mesh.source.inverted ? 2 : 1);
      } else {
        gl.uniform1i(this.uniforms.clip, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.emptyMask);
      }
      if (mesh.source.blend === 'add') gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
      else if (mesh.source.blend === 'multiply')
        gl.blendFuncSeparate(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      draw(mesh, false);
    }
    gl.bindVertexArray(null);
  }
  private deleteBuffers(buffer: MeshBuffers) {
    const gl = this.gl;
    gl.deleteBuffer(buffer.positions);
    gl.deleteBuffer(buffer.uv);
    gl.deleteBuffer(buffer.indices);
    if (buffer.colors) gl.deleteBuffer(buffer.colors);
    gl.deleteVertexArray(buffer.vao);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.alphas.length = 0;
    const gl = this.gl;
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    for (const b of this.buffers.values()) this.deleteBuffers(b);
    for (const { texture } of this.textureResources.values()) gl.deleteTexture(texture);
    gl.deleteTexture(this.maskTexture);
    gl.deleteTexture(this.emptyMask);
    this.textureResources.clear();
    this.buffers.clear();
    gl.deleteFramebuffer(this.maskBuffer);
    gl.deleteProgram(this.program);
  }
}
