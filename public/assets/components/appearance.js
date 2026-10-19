import { element } from './dom.js?v=1.4.0';
import { referenceCities } from './solar.js?v=1.4.0';

const modes = [
  ['light', '浅色', '回退到浅色工作台'],
  ['dark', '深色', '终端密度，高对比'],
  ['system', '跟随系统', '随设备外观切换'],
  ['solar', '日出日落', '白天浅色，夜晚深色'],
];

export function createAppearanceSettings(theme) {
  const close = element('button', {
    className: 'button button-subtle appearance-close btn btn-ghost-secondary', text: '关闭',
    attributes: { type: 'button', 'aria-label': '关闭外观设置' },
  });
  const modeField = element('fieldset', { className: 'appearance-modes' }, [
    element('legend', { className: 'form-label', text: '主题' }),
  ]);
  const radios = new Map();
  for (const [value, title, description] of modes) {
    const radio = element('input', { className: 'form-check-input', attributes: { type: 'radio', name: 'appearance-mode', value } });
    radios.set(value, radio);
    radio.addEventListener('change', () => {
      if (radio.checked) theme.setPreference({ ...theme.getState().preference, mode: value });
    });
    modeField.append(element('label', { className: 'appearance-option form-check' }, [
      radio,
      element('span', { className: 'form-check-label' }, [element('span', { className: 'appearance-option-title', text: title }),
        element('span', { className: 'appearance-option-note text-secondary', text: description })]),
    ]));
  }
  const location = element('select', { className: 'form-select', attributes: { id: 'appearance-location' } }, [
    element('option', { text: '自动 · 当前时区', attributes: { value: 'timezone' } }),
    ...referenceCities.map((city) => element('option', { text: city.name, attributes: { value: city.id } })),
    element('option', { text: '自定义经纬度', attributes: { value: 'custom' } }),
  ]);
  const latitude = element('input', {
    className: 'form-control',
    attributes: { id: 'appearance-latitude', type: 'number', min: '-90', max: '90', step: 'any', inputmode: 'decimal' },
  });
  const longitude = element('input', {
    className: 'form-control',
    attributes: { id: 'appearance-longitude', type: 'number', min: '-180', max: '180', step: 'any', inputmode: 'decimal' },
  });
  const coordinateError = element('p', {
    className: 'form-error', attributes: { role: 'alert', hidden: '' },
  });
  const custom = element('div', { className: 'appearance-custom', attributes: { hidden: '' } }, [
    element('div', { className: 'appearance-coordinates' }, [
      element('div', { className: 'form-field' }, [element('label', { className: 'form-label', text: '纬度 −90 至 90', attributes: { for: 'appearance-latitude' } }), latitude]),
      element('div', { className: 'form-field' }, [element('label', { className: 'form-label', text: '经度 −180 至 180', attributes: { for: 'appearance-longitude' } }), longitude]),
    ]),
    coordinateError,
    element('button', { className: 'button button-secondary btn btn-ghost-secondary', text: '应用参考位置', attributes: { type: 'submit' } }),
  ]);
  const reference = element('p', { className: 'appearance-reference' });
  const zone = element('p', { className: 'appearance-zone' });
  const sun = element('p', { className: 'appearance-sun', attributes: { 'aria-live': 'polite' } });
  const referenceNote = element('p', { className: 'appearance-reference-note' });
  const form = element('form', { className: 'appearance-form', attributes: { method: 'dialog' } }, [
    modeField,
    element('div', { className: 'appearance-location-field form-field' }, [
      element('label', { className: 'form-label', text: '日出日落参考位置', attributes: { for: 'appearance-location' } }), location,
    ]),
    custom,
    element('div', { className: 'appearance-summary' }, [reference, zone, sun, referenceNote]),
  ]);
  const dialog = element('dialog', { className: 'appearance-dialog', attributes: { 'aria-labelledby': 'appearance-title' } }, [
    element('div', { className: 'appearance-heading' }, [
      element('h2', { text: '外观设置', attributes: { id: 'appearance-title' } }), close,
    ]),
    element('p', { className: 'appearance-description', text: '深色是终端工作台。要离开它，选浅色、跟随系统，或日出日落。' }),
    form,
    element('p', { className: 'appearance-footnote', text: '设置只保存在此浏览器。日出日落在本机计算，无需定位权限。' }),
  ]);
  let returnFocus;

  function summary(state) {
    const { location: place, times } = state;
    const prefix = place.source === 'timezone' ? '时区参考城市' : '参考位置';
    reference.textContent = `${place.approximate ? '时区参考位置' : prefix}：${place.name}`;
    zone.textContent = `${place.timeZone} · ${place.latitude.toFixed(2)}°, ${place.longitude.toFixed(2)}°`;
    if (times.polar) sun.textContent = `今日${times.polar === 'day' ? '极昼 · 保持浅色' : '极夜 · 保持深色'}`;
    else {
      const format = new Intl.DateTimeFormat('zh-CN', { timeZone: times.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      sun.textContent = `今日日出 ${format.format(times.sunrise)}　日落 ${format.format(times.sunset)}`;
    }
    referenceNote.textContent = place.source === 'timezone'
      ? place.approximate ? '按时区经度与赤道纬度估算，可选择城市来提高准确度。'
        : '按浏览器时区选择参考城市，不代表你的实际所在位置。'
      : '日出日落时间为参考位置的当地时间，可能与实地观测略有差异。';
  }

  function populate() {
    const state = theme.getState();
    for (const [mode, radio] of radios) radio.checked = state.preference.mode === mode;
    const preferred = state.preference.location;
    location.value = preferred.source === 'preset' ? preferred.city : preferred.source;
    latitude.value = String(state.location.latitude);
    longitude.value = String(state.location.longitude);
    custom.hidden = location.value !== 'custom';
    coordinateError.hidden = true;
    summary(state);
  }

  location.addEventListener('change', () => {
    custom.hidden = location.value !== 'custom';
    coordinateError.hidden = true;
    if (location.value !== 'custom') {
      theme.setPreference({ ...theme.getState().preference,
        location: location.value === 'timezone' ? { source: 'timezone' } : { source: 'preset', city: location.value } });
      const place = theme.getState().location;
      latitude.value = String(place.latitude);
      longitude.value = String(place.longitude);
    } else latitude.focus();
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (location.value !== 'custom') return;
    const lat = latitude.value.trim() ? Number(latitude.value) : NaN;
    const lon = longitude.value.trim() ? Number(longitude.value) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      coordinateError.textContent = '请输入有效经纬度。纬度范围 −90 至 90，经度范围 −180 至 180。';
      coordinateError.hidden = false;
      return;
    }
    theme.setPreference({ ...theme.getState().preference, location: { source: 'custom', latitude: lat, longitude: lon } });
    coordinateError.hidden = true;
  });
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => returnFocus?.focus());
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  const unsubscribe = theme.subscribe((state) => {
    if (dialog.open) {
      summary(state);
      for (const [mode, radio] of radios) radio.checked = state.preference.mode === mode;
    }
  });
  return {
    element: dialog,
    open() {
      returnFocus = document.activeElement;
      theme.refresh();
      populate();
      if (!dialog.open) dialog.showModal();
    },
    stop() { unsubscribe(); dialog.close(); },
  };
}
