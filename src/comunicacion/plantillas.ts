/**
 * Gestión y renderizado de plantillas del Motor de Comunicación.
 *
 * Principio:
 *  - El operador no escribe prompts libres en campañas masivas. Elige una plantilla
 *    aprobada por Meta (o el canal correspondiente).
 *  - Toda variable requerida debe estar provista en el contexto.
 *  - La marca comercial (LFPC) debe figurar en el mensaje resultante.
 */

import type { PlantillaComunicacion } from './tipos';

export interface RenderResult {
  ok: boolean;
  texto?: string;
  variablesFaltantes: string[];
  error?: string;
}

/**
 * Renderiza el cuerpo de vista previa de una plantilla sustituyendo variables `{{clave}}`.
 * Inyecta o valida la presencia de la marca comercial.
 */
export function renderizarPlantilla(
  plantilla: PlantillaComunicacion,
  variables: Record<string, string>,
  marca: string
): RenderResult {
  const varsFaltantes: string[] = [];
  const varsDisponibles = { ...variables };

  // Si la marca no viene en las variables explícitas, inyectarla
  if (!varsDisponibles['marca'] && marca.trim()) {
    varsDisponibles['marca'] = marca.trim();
  }

  // Verificar variables requeridas por la plantilla
  for (const v of plantilla.variables) {
    if (!varsDisponibles[v] || !varsDisponibles[v].trim()) {
      varsFaltantes.push(v);
    }
  }

  if (varsFaltantes.length > 0) {
    return {
      ok: false,
      variablesFaltantes: varsFaltantes,
      error: `Variables requeridas faltantes: ${varsFaltantes.join(', ')}`,
    };
  }

  // Sustituir {{variable}}
  let texto = plantilla.bodyPreview;
  for (const [k, val] of Object.entries(varsDisponibles)) {
    const pattern = new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g');
    texto = texto.replace(pattern, val);
  }

  // Verificar presencia de la marca comercial en el texto (LFPC Art. 17)
  const marcaLimpia = marca.trim().toLowerCase();
  if (marcaLimpia && !texto.toLowerCase().includes(marcaLimpia)) {
    // Si la plantilla no incluyó la marca en el cuerpo, se añade firma de rigor
    texto = `${texto}\n\n— ${marca.trim()}`;
  }

  return {
    ok: true,
    texto,
    variablesFaltantes: [],
  };
}

/**
 * Convierte las variables a componentes de Meta Cloud API (`body` parameters).
 * Respeta el orden de `plantilla.variables`.
 */
export function construirComponentesMeta(
  plantilla: PlantillaComunicacion,
  variables: Record<string, string>
): Array<Record<string, unknown>> {
  const parameters = plantilla.variables.map((nombreVar) => {
    const val = variables[nombreVar] ?? '';
    return {
      type: 'text',
      text: val,
    };
  });

  return [
    {
      type: 'body',
      parameters,
    },
  ];
}
