<p align="center">
  <img src="assets/logo.svg" alt="Lattice Logo" width="144" height="144" />
</p>

<h1 align="center">Lattice</h1>

基于 Electron、React 和 TypeScript 的跨平台 Live2D 编辑器，使用自研 WebGL 2 渲染，支持 MCP 建模及中文、英文和日文界面。

- 打开、编辑和保存 `.cmo3`，导入分层 PSD。
- 网格编辑、变形器、参数关键形态、纹理图集和物理设置。
- 可停靠的编辑面板与撤销/重做。
- 通过 MCP 让 AI Agent 操作模型。

## 开发

需要 Node.js 22.12+ 和支持 WebGL 2 的图形环境。构建与运行无需 Cubism SDK。

```sh
npm ci
npm run dev
```

```sh
npm run build   # 类型检查与构建
npm start       # 运行生产构建
npm run pack    # 打包当前平台应用
```

## 当前状态

项目仍在开发中，尚未覆盖全部 Cubism 特性，暂不支持动画编辑和 `.moc3` 编译导出。

由 Cube 开发，采用 [MIT](LICENSE) 许可证。第三方资源说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
