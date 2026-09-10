export const manualMeshEn = {
  meshEditMode: 'Mesh edit mode',
  meshEditFinish: 'Done',
  meshEditLoading: 'Loading mesh…',
  meshEditShowOthers: 'Show other objects',
  meshEditSelect: 'Select vertices (V)',
  meshEditErase: 'Eraser (E)',
  meshEditEraserSize: 'Eraser size',
  meshEditUndo: 'Undo mesh edit',
  meshEditRedo: 'Redo mesh edit',
  meshEditConnect: 'Auto connect',
  meshEditConnectHint:
    'Fix the blue triangulation edges as normal connections, preserving hand-drawn edges and holes.',
  meshEditSubdivide: '4 Division',
  meshEditAddHint:
    'Click to add vertices and draw from selected points. Blue edges are automatic previews; Auto connect fixes them. Drag selected points to move them. Shift-click a selected point to deselect it.',
  meshEditSelectHint:
    'Click or drag to select vertices. Shift adds to the selection; Shift + Ctrl subtracts. Drag selected vertices to move them.',
  meshEditEraseHint:
    'Drag to erase edges and vertices within the circle. Hold Alt to erase only edges. The blue triangulation preview updates automatically. One stroke is one undo step.',
  meshEditShortcuts:
    'Space: pan · Wheel: zoom · Delete: remove · Ctrl Z: undo · Enter: done · Esc: cancel',
  meshEditFailed: 'Could not load the mesh for editing.',
  meshEditChanged: 'The model changed. Reopen mesh editing.',
  meshEditInvalid: 'Add or adjust vertices to form at least one valid triangle before finishing.',
};
export const manualMeshZh: Record<keyof typeof manualMeshEn, string> = {
  meshEditMode: '网格编辑模式',
  meshEditFinish: '完成',
  meshEditLoading: '正在加载网格…',
  meshEditShowOthers: '显示其他对象',
  meshEditSelect: '选择顶点（V）',
  meshEditErase: '橡皮擦（E）',
  meshEditEraserSize: '橡皮擦大小',
  meshEditUndo: '撤销网格编辑',
  meshEditRedo: '重做网格编辑',
  meshEditConnect: '自动连线',
  meshEditConnectHint: '将蓝色三角化补线固定为普通边，保留手工连线和孔洞。',
  meshEditSubdivide: '四分细分',
  meshEditAddHint:
    '单击加点并从选中点连续连线。蓝色线为自动补线，点击“自动连线”后固定。拖动选中点可移动；Shift 单击选中点可取消选中、结束连续连线。',
  meshEditSelectHint: '单击或拖框选择顶点，Shift 加选，Shift + Ctrl 减选。拖动选中顶点可一起移动。',
  meshEditEraseHint:
    '拖动擦除圆圈内的边和顶点，按住 Alt 只擦边。蓝色三角化补线会自动更新。整笔擦除可一次撤销。',
  meshEditShortcuts: '空格平移 · 滚轮缩放 · Delete 删除 · Ctrl Z 撤销 · Enter 完成 · Esc 取消',
  meshEditFailed: '无法加载待编辑的网格。',
  meshEditChanged: '模型已更改，请重新进入网格编辑。',
  meshEditInvalid: '完成前至少需要三个顶点组成有效三角形，请添加或调整顶点。',
};
export const manualMeshJa: Record<keyof typeof manualMeshEn, string> = {
  meshEditMode: 'メッシュ編集モード',
  meshEditFinish: '確定',
  meshEditLoading: 'メッシュを読み込み中…',
  meshEditShowOthers: '他のオブジェクトを表示',
  meshEditSelect: '頂点を選択（V）',
  meshEditErase: '消しゴム（E）',
  meshEditEraserSize: '消しゴムのサイズ',
  meshEditUndo: 'メッシュ編集を元に戻す',
  meshEditRedo: 'メッシュ編集をやり直す',
  meshEditConnect: '自動接続',
  meshEditConnectHint: '手動の接続と穴を保持し、青い補助線を通常の辺として確定します。',
  meshEditSubdivide: '4分割',
  meshEditAddHint:
    'クリックで頂点を追加し、選択点から接続。青い補助線は自動接続で確定します。選択点はドラッグで移動、Shift＋クリックで選択解除して連続接続を終了。',
  meshEditSelectHint:
    'クリックや範囲指定で頂点を選択。Shift で追加、Shift + Ctrl で除外。選択した頂点をまとめて移動できます。',
  meshEditEraseHint:
    'ドラッグで円内の辺と頂点を消去。Alt を押すと辺のみ消去します。青い補助線は自動更新され、一筆をまとめて元に戻せます。',
  meshEditShortcuts:
    'Space：移動 · ホイール：拡大縮小 · Delete：削除 · Ctrl Z：元に戻す · Enter：確定 · Esc：取消',
  meshEditFailed: '編集するメッシュを読み込めませんでした。',
  meshEditChanged: 'モデルが変更されました。メッシュ編集を開き直してください。',
  meshEditInvalid: '確定には有効な三角形を作る3頂点以上が必要です。頂点を追加・調整してください。',
};
