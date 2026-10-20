import { parseAmountToCents } from './money';

export interface CsvColumnMap {
  nombre: number;
  telefono: number;
  email: number;
  monto: number;
  vencimiento: number;
  ref: number;
  tieneEncabezado: boolean;
}

export interface CsvRow {
  nombre: string;
  telefono: string;
  email: string | null;
  monto: string;
  montoCents: number;
  vencimiento: string | null;
  ref: string | null;
  linea: number;
}

const KEYWORDS = {
  nombre: ['nombre', 'name', 'cliente', 'razon', 'razón', 'titular', 'deudor'],
  telefono: [
    'tel',
    'telefono',
    'teléfono',
    'phone',
    'cel',
    'celular',
    'whatsapp',
    'movil',
    'móvil',
    'numero',
    'número',
  ],
  email: ['email', 'correo', 'mail', 'e-mail'],
  monto: ['monto', 'amount', 'deuda', 'saldo', 'total', 'importe', 'cargo', 'adeudo', 'moneda'],
  vencimiento: ['venc', 'vencimiento', 'due', 'fecha', 'limite', 'límite'],
  ref: ['id', 'cuenta', 'factura', 'folio', 'clave', 'referencia', 'expediente', 'contrato'],
};

function detectDelimiter(line: string): string {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = -1;
  for (const candidate of candidates) {
    const count = line.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return bestCount > 0 ? best : ',';
}

/** Parser CSV mínimo con soporte de comillas y saltos de línea dentro de campo. */
export function parseCsvRows(text: string, delimiter?: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '');
  const sep = delimiter ?? detectDelimiter(clean.split(/\r?\n/)[0] ?? '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];

    if (inQuotes) {
      if (char === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === sep) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char === '\r') {
      continue;
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function normalizeHeader(cell: string): string {
  return cell
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function findColumn(headers: string[], keywords: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i] ?? '';
    if (keywords.some((keyword) => header.includes(keyword))) return i;
  }
  return -1;
}

/**
 * Detecta el mapa de columnas con heurística "neandertal": si no hay encabezados
 * reconocibles se asume el orden posicional nombre, teléfono, monto.
 */
export function detectColumns(rows: string[][]): CsvColumnMap {
  const first = rows[0] ?? [];
  const headers = first.map(normalizeHeader);

  const nombre = findColumn(headers, KEYWORDS.nombre);
  const telefono = findColumn(headers, KEYWORDS.telefono);
  const email = findColumn(headers, KEYWORDS.email);
  const monto = findColumn(headers, KEYWORDS.monto);
  const vencimiento = findColumn(headers, KEYWORDS.vencimiento);
  const ref = findColumn(headers, KEYWORDS.ref);

  const tieneEncabezado = [nombre, telefono, monto].filter((i) => i >= 0).length >= 2;

  if (tieneEncabezado) {
    return { nombre, telefono, email, monto, vencimiento, ref, tieneEncabezado: true };
  }

  return {
    nombre: 0,
    telefono: 1,
    email: -1,
    monto: 2,
    vencimiento: 3,
    ref: -1,
    tieneEncabezado: false,
  };
}

function parseDate(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const iso = /^\d{4}-\d{2}-\d{2}/.exec(trimmed);
  if (iso) return trimmed.slice(0, 10);

  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(trimmed);
  if (dmy) {
    const day = dmy[1]!.padStart(2, '0');
    const month = dmy[2]!.padStart(2, '0');
    let year = dmy[3]!;
    if (year.length === 2) year = `20${year}`;
    return `${year}-${month}-${day}`;
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

/**
 * Reensambla separadores de miles que el CSV dejó sin comillas.
 * `$8,450` llega como dos celdas ("8" y "450"); el monto real es 8450.
 */
function mergeSplitAmount(cells: string[], amountIndex: number): string[] {
  if (amountIndex < 0 || amountIndex + 1 >= cells.length) return cells;

  const currentRaw = (cells[amountIndex] ?? '').trim();
  const nextRaw = (cells[amountIndex + 1] ?? '').trim();

  const currentDigits = currentRaw.replace(/[^0-9]/g, '');
  if (!/^\d{1,3}$/.test(currentDigits)) return cells;
  if (!/^\d{3}$/.test(nextRaw)) return cells;

  const parsed = parseAmountToCents(currentRaw);
  if (parsed !== null && parsed >= 100_000) return cells;

  const merged = [...cells];
  merged[amountIndex] = `${currentDigits}${nextRaw}`;
  merged.splice(amountIndex + 1, 1);
  return merged;
}

/** Convierte filas CSV crudas en registros de cobranza normalizados. */
export function rowsToCollectionRows(rows: string[][]): CsvRow[] {
  if (rows.length === 0) return [];

  const map = detectColumns(rows);
  const dataRows = map.tieneEncabezado ? rows.slice(1) : rows;
  const output: CsvRow[] = [];

  dataRows.forEach((rawCells, index) => {
    const cells = mergeSplitAmount(rawCells, map.monto);
    const cell = (position: number): string =>
      position >= 0 ? (cells[position] ?? '').trim() : '';

    const nombre = cell(map.nombre);
    const telefonoRaw = cell(map.telefono);
    const emailRaw = cell(map.email);
    const montoRaw = cell(map.monto);
    const vencimientoRaw = cell(map.vencimiento);
    const refRaw = cell(map.ref);

    const montoCents = parseAmountToCents(montoRaw);
    if (!nombre && !telefonoRaw && montoCents === null) return;

    output.push({
      nombre: nombre || 'Cliente sin nombre',
      telefono: telefonoRaw,
      email: emailRaw || null,
      monto: montoRaw,
      montoCents: montoCents ?? 0,
      vencimiento: parseDate(vencimientoRaw),
      ref: refRaw || null,
      linea: index + (map.tieneEncabezado ? 2 : 1),
    });
  });

  return output;
}
