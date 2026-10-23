/**
 * Catálogo legal ejecutable.
 *
 * Cada entrada corresponde a una conducta del catálogo y se evalúa como código:
 * `evaluar` devuelve el detalle de la violación o `null` si la conducta no se
 * presenta. Las reglas `SANITIZE` incluyen `sanear`, que corrige el mensaje en
 * lugar de bloquearlo.
 *
 * La ley se toma del catálogo como fuente de verdad: `ley`, `articulo` y
 * `castigo` viajan con cada violación hasta la bitácora de auditoría.
 */

import type { ContextoLegal, MetaRegla } from './tipos';
import {
  contieneIdentidadLegal,
  esDominioPermitido,
  extraerClabes,
  extraerDominios,
  extraerTasasMentadas,
  PATRONES_AMENAZA,
  PATRONES_DESVIO_PAGO,
  PATRONES_EXTORSION,
  PATRONES_ROL_LEGAL,
  PATRONES_SMISHING,
  pieLegal,
  sanearAmenazas,
  sanearExtorsion,
  sanearLinks,
  sanearRolLegal,
  contieneAlguna,
} from './sanitizador';

export interface Regla extends MetaRegla {
  evaluar(ctx: ContextoLegal): string | null;
  sanear?: (ctx: ContextoLegal) => { texto: string; removidos: string[] };
}

const META = {
  '1.1': {
    id: '1.1',
    seccion: 'Identidad y Estructura Legal',
    conducta: 'Usurpación de identidad corporativa',
    descripcion: 'Mensajes sin razón social registrada ante CONDUSEF',
    ley: 'LFPC',
    articulo: 'Art. 112 Bis',
    castigo: 'Multa de $1,000 a $2,000,000 MXN (según reincidencia) y clausura.',
    accion: 'SANITIZE',
  },
  '1.2': {
    id: '1.2',
    seccion: 'Identidad y Estructura Legal',
    conducta: 'Representación sin poder legal',
    descripcion: 'Cobrador dice ser abogado, banco o autoridad sin acreditación',
    ley: 'Código Penal Federal / LFPC / LIC',
    articulo: 'Art. 250 CP + Art. 112 LFPC + Art. 111 LIC',
    castigo: 'Prisión de 1 a 6 años y de 100 a 300 días multa (Usurpación de funciones).',
    accion: 'SANITIZE',
  },
  '2.1': {
    id: '2.1',
    seccion: 'Cobranza y Acoso',
    conducta: 'Amenaza fuera de proceso o acceso ilícito al dispositivo',
    descripcion: 'Amenaza de embargo extrajudicial o alegar acceso al dispositivo/fotos del deudor',
    ley: 'Código Penal Federal',
    articulo: 'Art. 284 Bis (Cobranza extrajudicial ilegal) + Art. 211 Bis + Art. 282',
    castigo: 'Prisión de 2 a 5 años y multa de 50 a 300 días.',
    accion: 'SANITIZE',
  },
  '2.3': {
    id: '2.3',
    seccion: 'Cobranza y Acoso',
    conducta: 'Hostigamiento continuo o cobro anticipado (Día T-1)',
    descripcion:
      'Más de 3 impactos en <24h al mismo deudor o cobro antes de la fecha de vencimiento',
    ley: 'Código Penal Federal / NOM-184',
    articulo: 'Art. 284 Bis',
    castigo: 'Prisión de 2 a 5 años. Agravante si es a personas vulnerables.',
    accion: 'BLOCK',
  },
  '2.4': {
    id: '2.4',
    seccion: 'Cobranza y Acoso',
    conducta: 'Horario prohibido',
    descripcion: 'Mensaje fuera del horario 08:00 a 22:00',
    ley: 'NOM-184-SCFI-2012',
    articulo: 'Numeral 5.1.2',
    castigo: 'Sanción administrativa por PROFECO (multas de hasta $2M MXN) y clausura temporal.',
    accion: 'BLOCK',
  },
  '3.1': {
    id: '3.1',
    seccion: 'Smishing y Fraude',
    conducta: 'Smishing link apócrifo o acortador oculto',
    descripcion:
      'Envío de enlaces falsos, acortadores (bit.ly) o suplantación de marcas (Microsoft)',
    ley: 'Código Penal Federal',
    articulo: 'Art. 386 (Fraude) + 211 Bis (Acceso ilícito)',
    castigo: 'Prisión de 3 meses a 12 años (dependiendo del monto del fraude) y multas.',
    accion: 'SANITIZE',
  },
  '3.2': {
    id: '3.2',
    seccion: 'Smishing y Fraude',
    conducta: 'Destino de pago no trazable o contactación de 2º nivel',
    descripcion: 'SPEI/tarjeta/efectivo a cuenta personal fuera de la CLABE del contrato',
    ley: 'Código Penal Federal / LFPIORPI',
    articulo: 'Art. 400 Bis (Lavado de activos) + Art. 386 (Fraude)',
    castigo: 'Prisión de 5 a 15 años y multa de 1,000 a 5,000 días.',
    accion: 'BLOCK',
  },
  '4.2': {
    id: '4.2',
    seccion: 'Ciclo de Deuda y Extorsión',
    conducta: 'Interés sobre interés no pactado o tasa moratoria usuraria',
    descripcion: 'Capitalización no firmada o tasa de mora que contradice el contrato',
    ley: 'Ley para la Transparencia y Ordenamiento de Servicios Financieros / LACP',
    articulo: 'Art. 23 LCTC + Art. 2 LACP + Art. 386 CPF',
    castigo: 'Nulidad de la cláusula y sanciones de CONDUSEF/Banxico.',
    accion: 'BLOCK',
  },
  '4.4': {
    id: '4.4',
    seccion: 'Ciclo de Deuda y Extorsión',
    conducta: 'Extorsión por contactos y difusión de boletines',
    descripcion: 'Amenaza de difundir boletines a contactos de referencia, trabajo o redes',
    ley: 'Código Penal Federal',
    articulo: 'Art. 390 (Extorsión) + Art. 210 (Revelación de secretos)',
    castigo: 'Prisión de 3 a 9 años y de 300 a 900 días multa.',
    accion: 'SANITIZE',
  },
  '5.2': {
    id: '5.2',
    seccion: 'Operativos Judiciales',
    conducta: 'Simulación de orden judicial',
    descripcion: 'PDF con sello falso de juzgado',
    ley: 'Código Penal Federal',
    articulo: 'Art. 386 (Fraude Procesal) / Art. 244 (Falsificación de documentos)',
    castigo: 'Prisión de 4 a 8 años y multa de 200 a 2,000 días.',
    accion: 'BLOCK',
  },
  '8.1': {
    id: '8.1',
    seccion: 'Contrato vs CRM (Eje de Gravedad)',
    conducta: 'Monto contrato vs CRM diferente',
    descripcion: 'Inflación artificial de deuda entre lo firmado y lo mostrado',
    ley: 'Código Penal Federal / LFPC',
    articulo: 'Art. 386 (Fraude) + Art. 32 LFPC',
    castigo: 'Prisión de 3 meses a 12 años (según monto) y multas.',
    accion: 'BLOCK',
  },
  '8.7': {
    id: '8.7',
    seccion: 'Contrato vs CRM (Eje de Gravedad)',
    conducta: 'Llamadas registradas 1 vs Real 4',
    descripcion: 'Falsedad de declaraciones + violación de horario',
    ley: 'Código Penal Federal / NOM-184',
    articulo: 'Art. 284 Bis + NOM-184',
    castigo: 'Prisión de 2 a 5 años por falsedad y multas administrativas.',
    accion: 'BLOCK',
  },
} as const satisfies Record<string, MetaRegla>;

export const REGLAS: Regla[] = [
  {
    ...META['1.1'],
    evaluar(ctx) {
      if (!ctx.nombreLegal) {
        return 'El agente no tiene razón social configurada para este tenant.';
      }
      if (!contieneIdentidadLegal(ctx.mensaje, ctx.nombreLegal)) {
        return 'El mensaje no incluye la razón social registrada ante CONDUSEF.';
      }
      return null;
    },
    sanear(ctx) {
      const pie = pieLegal(ctx.nombreLegal, ctx.condusef);
      if (!pie) return { texto: ctx.mensaje, removidos: [] };
      if (contieneIdentidadLegal(ctx.mensaje, ctx.nombreLegal)) {
        return { texto: ctx.mensaje, removidos: [] };
      }
      return {
        texto: `${ctx.mensaje}\n\n${pie}`.trim(),
        removidos: ['Identidad legal (razón social + CONDUSEF) agregada al mensaje'],
      };
    },
  },

  {
    ...META['1.2'],
    evaluar(ctx) {
      const found = contieneAlguna(ctx.mensaje, PATRONES_ROL_LEGAL);
      return found ? `El mensaje presenta al agente como "${found}" sin acreditación legal.` : null;
    },
    sanear(ctx) {
      const resultado = sanearRolLegal(ctx.mensaje);
      return { texto: resultado.texto, removidos: resultado.removidos };
    },
  },

  {
    ...META['2.1'],
    evaluar(ctx) {
      const found = contieneAlguna(ctx.mensaje, PATRONES_AMENAZA);
      return found ? `Contiene amenaza extrajudicial o informática: "${found}".` : null;
    },
    sanear(ctx) {
      const resultado = sanearAmenazas(ctx.mensaje);
      return { texto: resultado.texto, removidos: resultado.removidos };
    },
  },

  {
    ...META['2.3'],
    accion: 'BLOCK',
    evaluar(ctx) {
      if (ctx.respuestaExenta) return null;
      if (ctx.contactos24h >= ctx.maxContactos24h) {
        return `El deudor ya recibió ${ctx.contactos24h} impactos en 24 h (tope ${ctx.maxContactos24h}).`;
      }
      if (ctx.fechaVencimiento && /^\d{4}-\d{2}-\d{2}$/.test(ctx.fechaVencimiento)) {
        const zonaHoraria = ctx.zonaHoraria ?? 'America/Mexico_City';
        const hoyIso = new Intl.DateTimeFormat('en-CA', {
          timeZone: zonaHoraria,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(ctx.ahora);
        if (ctx.fechaVencimiento > hoyIso) {
          return `Cobro anticipado (Día T-1): la deuda vence el ${ctx.fechaVencimiento} (hoy es ${hoyIso}).`;
        }
      }
      return null;
    },
  },

  {
    ...META['2.4'],
    accion: 'BLOCK',
    evaluar(ctx) {
      if (ctx.respuestaExenta) return null;
      const zonaHoraria = ctx.zonaHoraria ?? 'America/Mexico_City';
      const hora = Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone: zonaHoraria,
          hour: '2-digit',
          hour12: false,
        }).format(ctx.ahora)
      );
      if (Number.isNaN(hora)) return null;
      if (hora < ctx.ventanaContacto.inicio || hora >= ctx.ventanaContacto.fin) {
        return `Contacto fuera de la ventana legal (${ctx.ventanaContacto.inicio}:00–${ctx.ventanaContacto.fin}:00 ${zonaHoraria}): ${hora}:00.`;
      }
      return null;
    },
  },

  {
    ...META['3.1'],
    evaluar(ctx) {
      const smishing = contieneAlguna(ctx.mensaje, PATRONES_SMISHING);
      if (smishing) {
        return `Patrón de smishing / suplantación de marca detectado: "${smishing}".`;
      }
      const dominios = extraerDominios(ctx.mensaje).filter((d) => d.length > 0);
      const objectionable = dominios.filter((d) => !esDominioPermitido(d, ctx.dominiosPermitidos));
      if (objectionable.length > 0) {
        return `Enlace o acortador a dominio no autorizado: ${objectionable.join(', ')}.`;
      }
      return null;
    },
    sanear(ctx) {
      const resultado = sanearLinks(ctx.mensaje, ctx.dominiosPermitidos);
      return { texto: resultado.texto, removidos: resultado.removidos };
    },
  },

  {
    ...META['3.2'],
    accion: 'BLOCK',
    evaluar(ctx) {
      const desvio = contieneAlguna(ctx.mensaje, PATRONES_DESVIO_PAGO);
      if (desvio) {
        return `Contactación de 2º nivel / desvío a medio de pago no trazable: "${desvio}".`;
      }
      const clabes = extraerClabes(ctx.mensaje);
      if (clabes.length === 0) return null;
      if (!ctx.contrato?.clabe) {
        return `El mensaje incluye una cuenta/CLABE (${clabes[0]}) sin contrato que la respalde.`;
      }
      if (!clabes.includes(ctx.contrato.clabe)) {
        return `La cuenta/CLABE del mensaje (${clabes[0]}) difiere de la del contrato (${ctx.contrato.clabe}).`;
      }
      return null;
    },
  },

  {
    ...META['4.2'],
    accion: 'BLOCK',
    evaluar(ctx) {
      const tasas = extraerTasasMentadas(ctx.mensaje);
      for (const tasa of tasas) {
        if (tasa.esDiaria && tasa.valorPct >= 1) {
          return `Tasa de mora diaria usuraria en el mensaje (${tasa.textoOriginal}).`;
        }
        if (
          ctx.contrato?.tasa_pct !== null &&
          ctx.contrato?.tasa_pct !== undefined &&
          tasa.valorPct > ctx.contrato.tasa_pct
        ) {
          return `La tasa mencionada (${tasa.valorPct}%) supera la tasa pactada en el contrato (${ctx.contrato.tasa_pct}%).`;
        }
      }
      if (!ctx.contrato) return null;
      const tope = ctx.contrato.monto_pactado_cents + ctx.toleranciaCents;
      if (ctx.montoCents > tope) {
        return `El monto mostrado ($${(ctx.montoCents / 100).toLocaleString('es-MX')}) excede lo pactado ($${(ctx.contrato.monto_pactado_cents / 100).toLocaleString('es-MX')}).`;
      }
      return null;
    },
  },

  {
    ...META['4.4'],
    evaluar(ctx) {
      const found = contieneAlguna(ctx.mensaje, PATRONES_EXTORSION);
      return found ? `Amenaza de difusión de boletines o contacto a terceros: "${found}".` : null;
    },
    sanear(ctx) {
      const resultado = sanearExtorsion(ctx.mensaje);
      return { texto: resultado.texto, removidos: resultado.removidos };
    },
  },

  {
    ...META['5.2'],
    accion: 'BLOCK',
    evaluar(ctx) {
      const adjuntos = ctx.adjuntos ?? [];
      const sospechoso = adjuntos.filter((a) =>
        /juiz|juez|juzgado|sello|expediente|mandamiento|auto\s*judicial|embargo/i.test(a)
      );
      if (sospechoso.length > 0) {
        return `Se intenta enviar un documento con apariencia judicial: ${sospechoso.join(', ')}.`;
      }
      return null;
    },
  },

  {
    ...META['8.1'],
    accion: 'BLOCK',
    evaluar(ctx) {
      if (!ctx.contrato) return null;
      const esperado = ctx.contrato.monto_pactado_cents + ctx.toleranciaCents;
      if (Math.abs(ctx.montoCents - ctx.contrato.monto_pactado_cents) > ctx.toleranciaCents) {
        return `El monto del CRM ($${(ctx.montoCents / 100).toLocaleString('es-MX')}) difiere del monto del contrato ($${(ctx.contrato.monto_pactado_cents / 100).toLocaleString('es-MX')}).`;
      }
      if (ctx.montoCents > esperado) {
        return `El monto del CRM supera el tope pactado ($${(esperado / 100).toLocaleString('es-MX')}).`;
      }
      return null;
    },
  },

  {
    ...META['8.7'],
    accion: 'BLOCK',
    evaluar(ctx) {
      if (ctx.logsCrm !== ctx.logsReales) {
        return `Los registros del CRM declaran ${ctx.logsCrm} contactos y los logs reales registran ${ctx.logsReales}.`;
      }
      return null;
    },
  },
];

export function reglaPorId(id: string): Regla | undefined {
  return REGLAS.find((regla) => regla.id === id);
}
