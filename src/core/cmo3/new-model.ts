import { XMLSerializer } from '@xmldom/xmldom';
import type { Locale } from '../../shared/types';
import { Cmo3Archive } from './archive';
import { Cmo3Document } from './document';
import { XmlEdit } from './edit';
import { Cmo3Xml } from './xml';
import { partSource } from './parts';
import { parameterSource } from './parameters';

// The standard modeling preset observed in Editor 5: a 1000 × 2000 canvas,
// fifteen parts and twenty-seven unbound parameters. Names follow the UI locale.
const parts: [string, number, string, string, string][] = [
  ['Rough', 500, 'Rough Design', '草稿', '下絵'],
  ['Face', 500, 'Face', '脸', '顔'],
  ['Eye', 600, 'Eye', '眼睛', '目'],
  ['EyeBall', 600, 'Eyeball', '眼球', '目玉'],
  ['Brow', 600, 'Brows', '眉毛', '眉'],
  ['Mouth', 600, 'Mouth', '嘴', '口'],
  ['Nose', 600, 'Nose', '鼻子', '鼻'],
  ['Ear', 500, 'Ear', '耳朵', '耳'],
  ['HairFront', 700, 'Bangs', '前发', '前髪'],
  ['HairSide', 500, 'Hair Side', '侧发', '横髪'],
  ['HairBack', 300, 'Hair Back', '后发', '後ろ髪'],
  ['Neck', 400, 'Neck', '脖子', '首'],
  ['Body', 400, 'Body', '身体', '体'],
  ['Background', 0, 'Background', '背景', '背景'],
  ['Guide', 1000, '[Guide Image]', '[参考图]', '[ガイド画像]'],
];
const parameters: [string, number, number, number, string, string, string][] = [
  ['AngleX', -30, 30, 0, 'Angle X', '角度 X', '角度 X'],
  ['AngleY', -30, 30, 0, 'Angle Y', '角度 Y', '角度 Y'],
  ['AngleZ', -30, 30, 0, 'Angle Z', '角度 Z', '角度 Z'],
  ['EyeLOpen', 0, 1, 1, 'EyeL Open', '左眼 开闭', '左目 開閉'],
  ['EyeLSmile', 0, 1, 0, 'EyeL Smile', '左眼 微笑', '左目 笑顔'],
  ['EyeROpen', 0, 1, 1, 'EyeR Open', '右眼 开闭', '右目 開閉'],
  ['EyeRSmile', 0, 1, 0, 'EyeR Smile', '右眼 微笑', '右目 笑顔'],
  ['EyeBallX', -1, 1, 0, 'Eyeball X', '眼球 X', '目玉 X'],
  ['EyeBallY', -1, 1, 0, 'Eyeball Y', '眼球 Y', '目玉 Y'],
  ['BrowLY', -1, 1, 0, 'BrowL Y', '左眉 上下', '左眉 上下'],
  ['BrowRY', -1, 1, 0, 'BrowR Y', '右眉 上下', '右眉 上下'],
  ['BrowLX', -1, 1, 0, 'BrowL X', '左眉 左右', '左眉 左右'],
  ['BrowRX', -1, 1, 0, 'BrowR X', '右眉 左右', '右眉 左右'],
  ['BrowLAngle', -1, 1, 0, 'BrowL Angle', '左眉 角度', '左眉 角度'],
  ['BrowRAngle', -1, 1, 0, 'BrowR Angle', '右眉 角度', '右眉 角度'],
  ['BrowLForm', -1, 1, 0, 'BrowL Form', '左眉 变形', '左眉 変形'],
  ['BrowRForm', -1, 1, 0, 'BrowR Form', '右眉 变形', '右眉 変形'],
  ['MouthForm', -1, 1, 0, 'Mouth Form', '嘴 变形', '口 変形'],
  ['MouthOpenY', 0, 1, 0, 'Mouth Open', '嘴 开闭', '口 開閉'],
  ['Cheek', 0, 1, 0, 'Cheek', '脸红', '頬染め'],
  ['BodyAngleX', -10, 10, 0, 'Body X', '身体 旋转 X', '体の回転 X'],
  ['BodyAngleY', -10, 10, 0, 'Body Y', '身体 旋转 Y', '体の回転 Y'],
  ['BodyAngleZ', -10, 10, 0, 'Body Z', '身体 旋转 Z', '体の回転 Z'],
  ['Breath', 0, 1, 0, 'Breath', '呼吸', '呼吸'],
  ['HairFront', -1, 1, 0, 'Hair Move Front', '前发 摆动', '髪揺れ 前'],
  ['HairSide', -1, 1, 0, 'Hair Move Side', '侧发 摆动', '髪揺れ 横'],
  ['HairBack', -1, 1, 0, 'Hair Move Back', '后发 摆动', '髪揺れ 後'],
];

export function newModel(
  locale: Locale,
  options: { name?: string; width?: number; height?: number; defaultParts?: boolean } = {},
) {
  const language = locale === 'zh-CN' ? 1 : locale === 'ja' ? 2 : 0;
  const name = options.name ?? ['Untitled Model', '未命名模型', '名称未設定モデル'][language];
  const g = new Cmo3Xml(
    '<?xml version="1.0" encoding="UTF-8"?><root fileFormatVersion="503040001"><shared/><main><CModelSource isDefaultKeyformLocked="false"/></main></root>',
  );
  const e = new XmlEdit(g),
    root = partSource(e, { name: 'Root Part', id: '__RootPart__', drawOrder: 500 }, null),
    // Cubism's parameter selectors look up CParameterGroupGuid.ROOT_GROUP directly.
    rootGroupGuid = e.guid('CParameterGroupGuid', 'guid', 'e9fe6eff-953b-4ce2-be7c-4a7c3913686b');
  const groupId = rootGroupGuid.getAttribute('uuid')!;
  const parameterNodes = parameters.map(([id, min, max, value, ...names]) =>
    parameterSource(
      e,
      { id: 'Param' + id, name: names[language], min, max, default: value, description: '' },
      groupId,
    ),
  );
  const partNodes =
    options.defaultParts === false
      ? []
      : parts.map(([id, drawOrder, ...names]) => {
          const part = partSource(
            e,
            { id: 'Part' + id, name: names[language], drawOrder },
            root.id,
          );
          // Native guide images start hidden and do not participate in normal output.
          if (id === 'Guide') {
            e.value(part.source, 'isVisible', false);
            e.value(part.source, 'isSketch', true);
          }
          return part;
        });
  e.field(
    root.source,
    '_childGuids',
    e.list(
      'carray_list',
      '_childGuids',
      partNodes.map((p) => e.guid('CPartGuid', '', p.id)),
    ),
  );
  const group = e.identified(
    e.node('CParameterGroup', undefined, {}, [
      e.scalar('s', 'name', 'Root Parameter Group'),
      e.scalar('s', 'description', ''),
      e.scalar('b', 'folderIsOpened', true),
      rootGroupGuid,
      e.node('null', 'parentGroupGuid'),
      e.list(
        'carray_list',
        '_childGuids',
        parameterNodes.map((p) => e.ref(p.guid)),
      ),
      e.node('CParameterGroupId', 'id', { idstr: 'ParamGroupRoot' }),
      e.node('CLabelColor', 'labelColor', { customizedColorInt: -1 }, [
        e.node('CLabelColorType', 'labelType', { v: 'UNDEFINED' }),
      ]),
    ]),
  );
  const set = (
    tag: string,
    field: string,
    list: string,
    items: ReturnType<XmlEdit['node']>[] = [],
  ) => e.node(tag, field, {}, [e.list('carray_list', list, items)]);
  for (const n of [
    e.guid('CModelGuid', 'guid'),
    e.scalar('s', 'name', name),
    e.node('EditorEdition', 'editorEdition', {}, [e.scalar('i', 'edition', 12)]),
    e.node('CImageCanvas', 'canvas', {}, [
      e.scalar('i', 'pixelWidth', options.width ?? 1000),
      e.scalar('i', 'pixelHeight', options.height ?? 2000),
      e.node('CColor', 'background'),
    ]),
    set(
      'CParameterSourceSet',
      'parameterSourceSet',
      '_sources',
      parameterNodes.map((p) => p.node),
    ),
    e.node('CTextureManager', 'textureManager', {}, [
      set('TextureImageGroup', 'textureList', 'children'),
      ...[
        '_rawImages',
        '_modelImageGroups',
        '_textureAtlases',
        'artPathBrushUsingLayeredImageIds',
      ].map((f) => e.list('carray_list', f)),
      e.scalar('b', 'isTextureInputModelImageMode', true),
      e.scalar('i', 'previewReductionRatio', 1),
    ]),
    e.scalar('b', 'useLegacyDrawOrder__testImpl', false),
    set('CDrawableSourceSet', 'drawableSourceSet', '_sources'),
    set('CDeformerSourceSet', 'deformerSourceSet', '_sources'),
    set('CAffecterSourceSet', 'affecterSourceSet', '_sources'),
    set('CPartSourceSet', 'partSourceSet', '_sources', [
      root.source,
      ...partNodes.map((p) => p.source),
    ]),
    e.node('CPhysicsSettingsSourceSet', 'physicsSettingsSourceSet', {}, [
      e.list('carray_list', '_sourceCubismPhysics'),
      e.node('null', 'selectedCubismPhysics'),
      e.scalar('i', 'settingFPS', 60),
    ]),
    e.ref(root.source, 'rootPart'),
    set('CParameterGroupSet', 'parameterGroupSet', '_groups', [group]),
    e.ref(group, 'rootParameterGroup'),
    e.node('CModelInfo', 'modelInfo', {}, [
      e.scalar('f', 'pixelsPerUnit', 1),
      e.node('CPoint', 'originInPixels', {}, [e.scalar('i', 'x', 0), e.scalar('i', 'y', 0)]),
      e.node('CEffectParameterGroups', '_effectParameterGroups', {}, [
        e.node('hash_map', '_parameterGroups', { count: 0, keyType: 'string' }),
      ]),
    ]),
    e.node('hash_map', 'modelOptions', { count: 0, keyType: 'string' }),
    ...[64, 32, 16].map((s) => e.node('CImageIcon', `_icon${s}`, {}, [e.node('null', 'image')])),
    e.node('CGameMotionSet', 'gameMotionSet', {}, [
      e.list('carray_list', 'gameMotions'),
      e.list('carray_list', 'gameMotionGroups'),
    ]),
    e.node('ModelViewerSetting', 'modelViewerSetting', {}, [
      e.list('array_list', 'trackCursorSettings'),
    ]),
    set('CGuidesSetting', 'guides', 'guidesModeling'),
    e.scalar('i', 'targetVersionNo', 5030000),
    e.scalar('i', 'latestVersionOfLastModelerNo', 5030000),
    set('CArtPathBrushSetting', 'artPathBrushesSetting', 'brushes'),
    e.node('CRandomPoseSettingManager', 'randomPoseSetting', {}, [
      e.list('array_list', '_settings'),
      e.scalar('i', 'currentIndex', 0),
    ]),
    e.node('CMotionSyncSettingSourceSet', 'motionSyncSettingsSet', {}, [
      e.list('linked_set', '_settingSourceSetMotionSync'),
    ]),
  ])
    g.source.appendChild(n);
  e.versions({
    KeyformGridSource: 1,
    CParameterGroup: 4,
    SerializeFormatVersion: 2,
    CModelSource: 15,
    CFloatColor: 1,
    CLabelColor: 0,
  });
  e.imports([
    'com.live2d.cubism.doc.gameData.motions.CGameMotionSet',
    'com.live2d.cubism.doc.gameData.physics.CPhysicsSettingsSourceSet',
    ...[
      'ACForm',
      'ACParameterControllableSource',
      'CEffectParameterGroups',
      'CLabelColor',
      'CLabelColorType',
      'CModelInfo',
      'CModelSource',
      'affecter.CAffecterSourceSet',
      'deformer.CDeformerSourceSet',
      'drawable.AlphaComposition',
      'drawable.CDrawableSourceSet',
      'drawable.ColorComposition',
      'drawable.artPath.Line.CArtPathBrushSetting',
      'id.CParameterGroupId',
      'id.CParameterId',
      'interpolator.KeyformGridAccessKey',
      'interpolator.KeyformGridSource',
      'interpolator.KeyformOnGrid',
      'morphTarget.KeyFormMorphTargetSet',
      'morphTarget.MorphTargetBlendWeightConstraintSet',
      'motionSync.CMotionSyncSettingSourceSet',
      'options.edition.EditorEdition',
      'param.CParameterSource',
      'param.CParameterSource$Type',
      'param.CParameterSourceSet',
      'param.group.CParameterGroup',
      'param.group.CParameterGroupSet',
      'parts.CPartSourceSet',
      'randomPose.CRandomPoseSettingManager',
      'texture.CTextureManager',
      'texture.TextureImageGroup',
    ].map((s) => 'com.live2d.cubism.doc.model.' + s),
    'com.live2d.cubism.doc.modeling.ui.guide.CGuidesSetting',
    'com.live2d.cubism.doc.modeling.ui.viewer.ModelViewerSetting',
    'com.live2d.graphics.CImageCanvas',
    ...[
      'CFloatColor',
      'CFormGuid',
      'CImageIcon',
      'CModelGuid',
      'CParameterGroupGuid',
      'CParameterGuid',
      'CPoint',
    ].map((s) => 'com.live2d.type.' + s),
  ]);
  // Resolve references once all definitions have been attached; serialization then
  // hoists them into the native shared-object pool.
  const draft = new Cmo3Document(
    Cmo3Archive.create(new XMLSerializer().serializeToString(g.document)).bytes,
    null,
  );
  return new Cmo3Document(draft.serialize(), null);
}
