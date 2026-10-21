// What vehicle a lot is (make / model / year) from its title. Used to store clean records and to
// group our own sold results. No database imports here, so anything can use it.
const MAKES = ['toyota', 'ford', 'holden', 'nissan', 'mazda', 'mitsubishi', 'hyundai', 'kia', 'isuzu', 'hino', 'volvo', 'scania', 'kenworth',
  'mack', 'iveco', 'fuso', 'mercedes-benz', 'mercedes', 'renault', 'volkswagen', 'subaru', 'suzuki', 'honda', 'bmw', 'audi', 'jeep',
  'land rover', 'range rover', 'ldv', 'great wall', 'gwm', 'haval', 'mg', 'peugeot', 'citroen', 'skoda', 'tesla', 'chrysler', 'dodge',
  'ram', 'chevrolet', 'lexus', 'porsche', 'jaguar', 'yamaha', 'kawasaki', 'harley-davidson', 'harley', 'ducati', 'ktm', 'triumph',
  'daihatsu', 'ssangyong', 'foton', 'freightliner', 'western star', 'international', 'daf', 'man', 'byd', 'cupra', 'alfa romeo', 'fiat', 'mini'];
const MAKE_RE = new RegExp(`\\b(${MAKES.map(m => m.replace(/[-\s]/g, '[- ]?')).join('|')})\\b\\s+([a-z0-9][a-z0-9-]*)`, 'i');
const canon = m => m.toLowerCase().replace(/[- ]/g, '').replace(/^mercedesbenz$/, 'mercedes').replace(/^harleydavidson$/, 'harley').replace(/^rangerover$/, 'landrover');

/** "2016 Mercedes-Benz Sprinter 316 CDI" -> { make: 'mercedes', model: 'sprinter', year: 2016 } */
export function identify(lot) {
  const t = String(lot.title || '');
  const m = MAKE_RE.exec(t);
  if (!m) return null;
  const year = lot.year || Number((/\b(19[5-9]\d|20[0-3]\d)\b/.exec(t) || [])[1]) || null;
  return { make: canon(m[1]), model: m[2].toLowerCase(), year };
}

/** Pickles' detail-page titles: "CP: 01/2014, Hino, 300 Series 616, Cab Chassis" -> "2014 Hino 300 Series 616 Cab Chassis" */
export function tidyTitle(t) {
  if (!t) return t;
  t = String(t).replace(/\s*[-–|]\s*(?:image|photo|picture)\s*\d+\s*$/i, '');   // a photo's caption ("... - Image 1")
  const m = /^\s*CP\s*:\s*(?:\d{1,2}\/)?(\d{4})\s*,\s*(.+)$/i.exec(t);
  if (m) return `${m[1]} ${m[2].split(',').map(x => x.trim()).filter(Boolean).join(' ')}`.replace(/\s+/g, ' ').trim();
  return t.replace(/^\s*CP\s*:\s*/i, '').trim();
}
