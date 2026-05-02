import React from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';

export interface BookmarkDialogValue {
  name: string;
  country: string;
  note: string;
  lat: string;
  lng: string;
  category: string;
}

interface BookmarkDialogProps {
  open: boolean;
  mode: 'create' | 'edit';
  categories: string[];
  value: BookmarkDialogValue;
  onChange: (value: BookmarkDialogValue) => void;
  onSave: () => void;
  onCancel: () => void;
}

const BookmarkDialog: React.FC<BookmarkDialogProps> = ({
  open,
  mode,
  categories,
  value,
  onChange,
  onSave,
  onCancel,
}) => {
  const t = useT();
  if (!open) return null;

  const update = (patch: Partial<BookmarkDialogValue>) => {
    onChange({ ...value, ...patch });
  };

  return createPortal(
    <div
      onClick={onCancel}
      className="anim-fade-in"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(8, 10, 20, 0.55)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="anim-scale-in"
        style={{
          background: 'rgba(26, 29, 39, 0.96)',
          backdropFilter: 'blur(14px)',
          WebkitBackdropFilter: 'blur(14px)',
          border: '1px solid rgba(108, 140, 255, 0.2)',
          borderRadius: 12,
          padding: 18,
          width: 320,
          color: '#e0e0e0',
          boxShadow: '0 20px 60px rgba(12, 18, 40, 0.65), 0 0 0 1px rgba(255, 255, 255, 0.05) inset',
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
          {mode === 'create' ? t('bm.add') : t('bm.edit')}
        </div>
        <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 10 }}>
          {value.lat && value.lng ? `${value.lat}, ${value.lng}` : t('bm.no_position')}
        </div>
        <select
          value={value.category}
          onChange={(e) => update({ category: e.target.value })}
          style={{
            width: '100%',
            marginBottom: 8,
            padding: '6px 8px',
            background: '#1e1e22',
            color: '#e0e0e0',
            border: '1px solid #444',
            borderRadius: 4,
            fontSize: 12,
          }}
        >
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <input
          type="text"
          className="search-input"
          placeholder={t('bm.name_placeholder')}
          value={value.name}
          autoFocus
          onChange={(e) => update({ name: e.target.value })}
          style={{ width: '100%', marginBottom: 8 }}
        />
        <input
          type="text"
          className="search-input"
          placeholder={t('bm.country_placeholder')}
          value={value.country}
          onChange={(e) => update({ country: e.target.value })}
          style={{ width: '100%', marginBottom: 8 }}
        />
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <input
            type="text"
            className="search-input"
            inputMode="decimal"
            placeholder={t('bm.lat_placeholder')}
            value={value.lat}
            onChange={(e) => update({ lat: e.target.value })}
            style={{ flex: 1 }}
          />
          <input
            type="text"
            className="search-input"
            inputMode="decimal"
            placeholder={t('bm.lng_placeholder')}
            value={value.lng}
            onChange={(e) => update({ lng: e.target.value })}
            style={{ flex: 1 }}
          />
        </div>
        <textarea
          className="search-input"
          placeholder={t('bm.note_placeholder').toUpperCase()}
          value={value.note}
          onChange={(e) => update({ note: e.target.value })}
          style={{ width: '100%', marginBottom: 8, minHeight: 64, resize: 'vertical' }}
        />
        <div style={{ height: 4 }} />
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="action-btn primary"
            style={{ flex: 1 }}
            disabled={!value.name.trim() || !Number.isFinite(parseFloat(value.lat)) || !Number.isFinite(parseFloat(value.lng))}
            onClick={onSave}
          >
            {mode === 'create' ? t('generic.add') : t('generic.save')}
          </button>
          <button className="action-btn" onClick={onCancel}>
            {t('generic.cancel')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

export default BookmarkDialog;
