import { useState } from 'react';
import { useEditor } from '../store';
import { type AtlasImage, type TextureAtlas } from '../../../shared/atlas';
import { autoLayoutAtlas } from '../../../shared/atlas-layout';

export const atlasSizes = [64, 128, 256, 512, 1024, 2048, 4096, 8192];

export function AtlasCreate({
  images,
  visible,
  number,
  padding,
  create,
  cancel,
}: {
  images: AtlasImage[];
  visible: ReadonlySet<string>;
  number: number;
  padding: number;
  create: (atlas: TextureAtlas) => void;
  cancel: () => void;
}) {
  const { t } = useEditor();
  const [name, setName] = useState(`${t('atlasPage')} ${number}`),
    [width, setWidth] = useState(1024),
    [height, setHeight] = useState(1024),
    [layout, setLayout] = useState('all'),
    [error, setError] = useState('');
  return (
    <form
      role="dialog"
      aria-modal="true"
      aria-label={t('createAtlas')}
      className="modeling-dialog atlas-create"
      onSubmit={(e) => {
        e.preventDefault();
        const packed = autoLayoutAtlas(
          { atlases: [], unassigned: images },
          visible,
          {
            name: name.trim(),
            width,
            height,
            padding,
            addImages: layout === 'all' ? 'unassigned' : layout === 'visible' ? 'visible' : [],
          },
          crypto.randomUUID(),
        );
        if (!packed) {
          setError(t('atlasDoesNotFit'));
          return;
        }
        create(packed);
      }}
    >
      <h2>{t('createAtlas')}</h2>
      <label className="property">
        <span>{t('name')}</span>
        <input
          autoFocus
          required
          maxLength={256}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {(
        [
          ['width', width, setWidth],
          ['height', height, setHeight],
        ] as const
      ).map(([key, value, set]) => (
        <label className="property" key={key}>
          <span>{t(key === 'width' ? 'atlasWidth' : 'atlasHeight')}</span>
          <select value={value} onChange={(e) => set(Number(e.target.value))}>
            {atlasSizes.map((size) => (
              <option key={size} value={size}>
                {size} px
              </option>
            ))}
          </select>
        </label>
      ))}
      <label className="property">
        <span>{t('atlasDefaultLayout')}</span>
        <select value={layout} onChange={(e) => setLayout(e.target.value)}>
          <option value="all">{t('atlasAllImages')}</option>
          <option value="visible">{t('atlasVisibleImages')}</option>
          <option value="none">{t('atlasNoImages')}</option>
        </select>
      </label>
      <p className="hint">{t('atlasCreateHint')}</p>
      {error && (
        <p role="alert" className="atlas-error">
          {error}
        </p>
      )}
      <footer>
        <button type="button" onClick={cancel}>
          {t('cancel')}
        </button>
        <button className="primary" disabled={!name.trim()}>
          {t('create')}
        </button>
      </footer>
    </form>
  );
}
