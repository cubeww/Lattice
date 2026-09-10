import type { Element } from '@xmldom/xmldom';
import { XmlEdit } from './edit';

export const imageAffine = (e: XmlEdit, name: string, x = 0, y = 0, sx = 1, sy = 1) =>
  e.node('CAffine', name, { m00: sx, m01: 0, m02: x, m10: 0, m11: sy, m12: y });

/** Cubism's native layer selector → image filter graph. */
export function imageFilter(e: XmlEdit, layer: Element, imageGuid: string) {
  const set = e.identified(e.node('ModelImageFilterSet', 'inputFilter'));
  const selector = e.identified(
    e.node('FilterInstance', undefined, { filterName: 'CLayerSelector' }),
  );
  const filter = e.identified(e.node('FilterInstance', undefined, { filterName: 'CLayerFilter' }));
  const id = (value: string, name?: string) => e.node('FilterValueId', name, { idstr: value });
  const def = (value: string, name: string) =>
    e.node('FilterValue', name, {}, [
      e.scalar('s', 'name', value),
      id(value, 'id'),
      e.node('null', 'defaultValueInitializer'),
    ]);
  const entry = (key: Element, value: Element) => {
    key.setAttribute('xs.n', 'key');
    value.setAttribute('xs.n', 'value');
    return e.node('entry', undefined, {}, [key, value]);
  };
  const connector = e.identified(
    e.node('FilterOutputValueConnector', undefined, {}, [
      e.node('AValueConnector', 'super'),
      e.ref(selector, 'instance'),
      id('ilf_outputLayerData', 'id'),
      def('ilf_outputLayerData', 'valueDef'),
    ]),
  );
  const inputs = [
    ['mi_input_layerInputData', 'ilf_inputLayerData'],
    ['mi_currentImageGuid', 'ilf_currentImageGuid'],
  ];
  const outputs = [
    ['mi_output_image', 'ilf_outputImageRes'],
    ['mi_output_transform', 'ilf_outputTransform'],
  ];
  [selector, filter].forEach((node, index) => {
    for (const field of [
      e.guid(
        'StaticFilterDefGuid',
        'filterDefGuid',
        index ? '4083cd1f-40ba-4eda-8400-379019d55ed8' : '5e9fe1ea-0ec3-4d68-a5fa-018fc7abe301',
      ),
      e.node('null', 'filterDef'),
      e.node('FilterInstanceId', 'filterId', { idstr: 'filter' + index }),
      e.list(
        'hash_map',
        'inputConnectors',
        index
          ? [entry(id('ilf_inputLayer'), e.ref(connector))]
          : inputs.map(([env, port]) =>
              entry(
                id(port),
                e.node('EnvValueConnector', undefined, {}, [
                  e.node('AValueConnector', 'super'),
                  id(env, 'envValueId'),
                ]),
              ),
            ),
      ),
      e.list(
        'hash_map',
        'outputConnectors',
        index ? [] : [entry(id('ilf_outputLayerData'), connector)],
      ),
      e.ref(set, 'ownerFilterSet'),
    ])
      node.appendChild(field);
  });
  set.appendChild(
    e.node('FilterSet', 'super', {}, [
      e.list(
        'linked_map',
        'filterMap',
        [selector, filter].map((n, i) =>
          entry(e.node('FilterInstanceId', undefined, { idstr: 'filter' + i }), n),
        ),
      ),
      ...[inputs, outputs].map((ports, i) =>
        e.list(
          'linked_map',
          i ? '_externalOutputs' : '_externalInputs',
          ports.map(([env, port]) =>
            entry(
              id(env),
              e.node('EnvConnection', undefined, {}, [
                def(env, '_envValueDef'),
                e.ref(i ? filter : selector, 'filter'),
                def(port, 'filterValueDef'),
              ]),
            ),
          ),
        ),
      ),
    ]),
  );
  const envValue = (key: string, value: Element) =>
    entry(
      id(key),
      e.node('EnvValueSet', undefined, {}, [
        id(key, 'id'),
        value,
        e.scalar('l', 'updateTimeMs', Date.now()),
      ]),
    );
  const env = e.node('ModelImageFilterEnv', 'inputFilterEnv', {}, [
    e.node('FilterEnv', 'super', {}, [
      e.node('null', 'parentEnv'),
      e.list('hash_map', 'envValues', [
        envValue('mi_currentImageGuid', e.guid('CLayeredImageGuid', 'value', imageGuid)),
        envValue(
          'mi_input_layerInputData',
          e.node('CLayerSelectorMap', 'value', {}, [
            e.list('linked_map', '_imageToLayerInput', [
              entry(
                e.guid('CLayeredImageGuid', '', imageGuid),
                e.list('array_list', '', [
                  e.node('CLayerInputData', undefined, {}, [
                    e.ref(layer, 'layer'),
                    imageAffine(e, 'affine'),
                    e.node('null', 'clippingOnTexturePx'),
                  ]),
                ]),
              ),
            ]),
          ]),
        ),
      ]),
    ]),
  ]);
  e.imports([
    ...['CLayerInputData', 'CLayerSelectorMap', 'ModelImageFilterEnv', 'ModelImageFilterSet'].map(
      (s) => 'com.live2d.cubism.doc.model.extension.textureInput.inputFilter.' + s,
    ),
    ...[
      'AValueConnector',
      'FilterEnv',
      'FilterEnv$EnvValueSet',
      'FilterSet',
      'FilterSet$EnvConnection',
      'FilterValue',
      'concreteConnector.EnvValueConnector',
      'concreteConnector.FilterOutputValueConnector',
      'filterInstance.FilterInstance',
      'id.FilterInstanceId',
      'id.FilterValueId',
    ].map((s) => 'com.live2d.graphics.filter.' + s),
    'com.live2d.type.StaticFilterDefGuid',
    'com.live2d.type.CAffine',
  ]);
  return [set, env];
}
