export const filesEn = {
  psdImport: 'Import PSD',
  psdNew: 'Open as a new model',
  psdNewHint: 'Create a model using the PSD canvas and layers.',
  psdAdd: 'Add as a new group',
  psdAddHint: 'Add the layers to the current model in a new Part group, keeping its canvas size.',
  psdReplace: 'Replace existing PSD',
  psdReplaceHint:
    'Match layers by ID, name and position. Preserve meshes, parameters and deformers; add unmatched new layers and retain missing old layers.',
  psdTarget: 'PSD to replace',
  psdPrevious: 'previous source',
  psdCurrentModel: 'Current model',
  psdImporting: 'Importing PSD…',
  psdImportApply: 'Import',
  psdProjectChanged: 'The model changed. Cancel and open the PSD again.',
};
export const filesZh: Record<keyof typeof filesEn, string> = {
  psdImport: '导入 PSD',
  psdNew: '打开为新模型',
  psdNewHint: '使用 PSD 的画布尺寸和图层创建模型。',
  psdAdd: '添加为新组',
  psdAddHint: '将图层作为新的部件组加入当前模型，保留当前画布尺寸。',
  psdReplace: '替换当前模型的 PSD',
  psdReplaceHint:
    '根据图层 ID、名称和位置匹配，保留网格、参数和变形器；加入新增图层，保留未匹配的旧图层。',
  psdTarget: '要替换的 PSD',
  psdPrevious: '历史素材',
  psdCurrentModel: '当前模型',
  psdImporting: '正在导入 PSD…',
  psdImportApply: '导入',
  psdProjectChanged: '模型已更改，请取消后重新打开 PSD。',
};
export const filesJa: Record<keyof typeof filesEn, string> = {
  psdImport: 'PSDをインポート',
  psdNew: '新規モデルとして開く',
  psdNewHint: 'PSDのキャンバスサイズとレイヤーからモデルを作成します。',
  psdAdd: '新しいグループとして追加',
  psdAddHint: 'キャンバスサイズを保ち、現在のモデルに新しいパーツグループとして追加します。',
  psdReplace: '既存のPSDを置き換える',
  psdReplaceHint:
    'レイヤーID・名前・位置を照合し、メッシュ・パラメータ・デフォーマを保持。新規レイヤーを追加し、未一致の旧レイヤーも保持します。',
  psdTarget: '置き換えるPSD',
  psdPrevious: '以前の素材',
  psdCurrentModel: '現在のモデル',
  psdImporting: 'PSDをインポート中…',
  psdImportApply: 'インポート',
  psdProjectChanged: 'モデルが変更されました。キャンセルしてPSDを開き直してください。',
};
