import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');

const CONFIG = {
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN,
  AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || 'Citas',
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY
};

const TIMEZONE = 'America/Guayaquil';

// ═══════════════════════════════════════════════════════════════
// FUNCIONES DE FECHA/HORA
// ═══════════════════════════════════════════════════════════════

function getFechaEcuador(offsetDias = 0) {
  const ahora = new Date();
  const opciones = { timeZone: TIMEZONE, year: 'numeric', month: 'numeric', day: 'numeric' };
  const formatter = new Intl.DateTimeFormat('en-US', opciones);
  const parts = formatter.formatToParts(ahora);
  const year = parts.find(p => p.type === 'year')?.value || '2026';
  const month = parts.find(p => p.type === 'month')?.value || '1';
  const day = parts.find(p => p.type === 'day')?.value || '1';
  const fecha = new Date(Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day)));
  fecha.setUTCDate(fecha.getUTCDate() + offsetDias);
  return fecha.toISOString().split('T')[0];
}

function formatearFecha(fechaISO) {
  if (!fechaISO || !fechaISO.match(/^\d{4}-\d{2}-\d{2}$/)) {
    return fechaISO || 'fecha por confirmar';
  }
  const [anio, mes, dia] = fechaISO.split('-').map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia, 12, 0, 0));
  return fecha.toLocaleDateString('es-EC', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
  });
}

function formatearHora(horaStr) {
  if (!horaStr) return '';
  const [h, m] = horaStr.split(':').map(Number);
  const periodo = h >= 12 ? 'p.m.' : 'a.m.';
  const h12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
  return `${h12}:${m.toString().padStart(2, '0')} ${periodo}`;
}

// ═══════════════════════════════════════════════════════════════
// AIRTABLE: BÚSQUEDA ROBUSTA POR MÚLTIPLES CRITERIOS
// ═══════════════════════════════════════════════════════════════

async function buscarCitaAirtable({ supabaseId, telefono, fecha, hora, especialista }) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;

    // Intento 1: Por ID_Supabase (más confiable si existe)
    if (supabaseId) {
      const filter1 = encodeURIComponent(`{ID_Supabase} = '${supabaseId}'`);
      const res1 = await axios.get(`${url}?filterByFormula=${filter1}`, {
        headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
      });
      if (res1.data.records?.length) {
        console.log('✅ Airtable encontrado por ID_Supabase:', supabaseId);
        return { ok: true, record: res1.data.records[0] };
      }
      console.log('⚠️ No encontrado por ID_Supabase:', supabaseId, '- intentando fallback...');
    }

    // Intento 2: Por Teléfono + Fecha + Hora + Especialista
    if (telefono && fecha && hora) {
      const condiciones = [
        `{Teléfono} = '${telefono}'`,
        `IS_SAME({Fecha}, '${fecha}', 'days')`,
        `{Hora} = '${hora}'`
      ];
      if (especialista) condiciones.push(`{Especialista} = '${especialista}'`);

      const filter2 = encodeURIComponent(`AND(${condiciones.join(', ')})`);
      const res2 = await axios.get(`${url}?filterByFormula=${filter2}`, {
        headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
      });
      if (res2.data.records?.length) {
        console.log('✅ Airtable encontrado por fallback teléfono+fecha+hora');
        return { ok: true, record: res2.data.records[0] };
      }
    }

    // Intento 3: Por Teléfono + Fecha (más amplio, por si la hora cambió en el registro)
    if (telefono && fecha) {
      const filter3 = encodeURIComponent(`AND({Teléfono} = '${telefono}', IS_SAME({Fecha}, '${fecha}', 'days'))`);
      const res3 = await axios.get(`${url}?filterByFormula=${filter3}`, {
        headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
      });
      if (res3.data.records?.length) {
        console.log('✅ Airtable encontrado por fallback teléfono+fecha');
        return { ok: true, record: res3.data.records[0] };
      }
    }

    console.log('❌ Cita no encontrada en Airtable con ningún criterio');
    return { ok: false, error: 'No encontrado' };
  } catch (error) {
    console.error('Error buscando en Airtable:', error.response?.data || error.message);
    return { ok: false, error: error.message };
  }
}

async function crearCitaAirtable(datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const [h, min] = datos.hora.split(':').map(Number);
    const [anio, mes, dia] = datos.fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();

    console.log('📝 Creando en Airtable - ID_Supabase:', datos.supabase_id);

    const payload = {
      records: [{
        fields: {
          "Cliente": `${datos.nombre} ${datos.apellido}`.trim(),
          "Servicio": datos.servicio,
          "Fecha": fechaUTC,
          "Hora": datos.hora,
          "Especialista": datos.especialista,
          "Teléfono": datos.telefono,
          "Estado": "Confirmada",
          "Importe estimado": datos.precio,
          "Duración estimada (minutos)": datos.duracion,
          "ID_Supabase": datos.supabase_id || null,
          "Email de cliente": datos.email || null,
          "Notas de la cita": datos.notas || null,
          "Observaciones de confirmación": datos.observaciones || null
        }
      }]
    };

    const response = await axios.post(url, payload, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });

    console.log('✅ Airtable creado, record ID:', response.data.records?.[0]?.id);
    return { ok: true, recordId: response.data.records?.[0]?.id };
  } catch (error) {
    console.error('Error Airtable Create:', error.response?.data || error.message);
    return { ok: false, error: error.message };
  }
}

async function actualizarCitaAirtable(supabaseId, nuevosDatos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;

    // Buscar con fallback robusto
    const busqueda = await buscarCitaAirtable({
      supabaseId,
      telefono: nuevosDatos.telefono,
      fecha: nuevosDatos.fechaAnterior,
      hora: nuevosDatos.horaAnterior,
      especialista: nuevosDatos.especialistaAnterior
    });

    if (!busqueda.ok) {
      console.error('❌ No se pudo encontrar la cita en Airtable para actualizar');
      return { ok: false, error: 'Cita no encontrada en Airtable' };
    }

    const recordId = busqueda.record.id;
    const [h, min] = nuevosDatos.hora.split(':').map(Number);
    const [anio, mes, dia] = nuevosDatos.fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();

    const payload = {
      records: [{
        id: recordId,
        fields: {
          "Fecha": fechaUTC,
          "Hora": nuevosDatos.hora,
          "Especialista": nuevosDatos.especialista,
          "Estado": "Confirmada",
          "Observaciones de confirmación": nuevosDatos.observaciones || "Cita reagendada"
        }
      }]
    };

    // Si tenemos el ID_Supabase correcto, actualizarlo también
    if (supabaseId && !busqueda.record.fields.ID_Supabase) {
      payload.records[0].fields["ID_Supabase"] = supabaseId;
    }

    await axios.patch(url, payload, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });

    console.log('✅ Airtable actualizado, record ID:', recordId);
    return { ok: true, recordId };
  } catch (error) {
    console.error('Error Airtable Update:', error.response?.data || error.message);
    return { ok: false, error: error.message };
  }
}

async function cancelarCitaAirtable(supabaseId, motivo, datosFallback) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;

    // Buscar con fallback robusto
    const busqueda = await buscarCitaAirtable({
      supabaseId,
      telefono: datosFallback?.telefono,
      fecha: datosFallback?.fecha,
      hora: datosFallback?.hora,
      especialista: datosFallback?.especialista
    });

    if (!busqueda.ok) {
      console.error('❌ No se pudo encontrar la cita en Airtable para cancelar');
      return { ok: false, error: 'Cita no encontrada en Airtable' };
    }

    const recordId = busqueda.record.id;

    await axios.patch(url, {
      records: [{
        id: recordId,
        fields: {
          "Estado": "Cancelada",
          "Observaciones de confirmación": motivo ? `Cancelada: ${motivo}` : "Cancelada por cliente"
        }
      }]
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });

    console.log('✅ Airtable cancelado, record ID:', recordId);
    return { ok: true, recordId };
  } catch (error) {
    console.error('Error Airtable Cancel:', error.response?.data || error.message);
    return { ok: false, error: error.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// VERIFICACIÓN DE DISPONIBILIDAD (Airtable + Supabase)
// ═══════════════════════════════════════════════════════════════

async function obtenerCitasDelDia(fecha) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND(IS_SAME({Fecha}, '${fecha}', 'days'), {Estado} = 'Confirmada')`);

    const response = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });

    const citasAirtable = (response.data.records || []).map(c => ({
      hora: c.fields.Hora,
      duracion: c.fields['Duración estimada (minutos)'] || 60,
      especialista: c.fields.Especialista,
      servicio: c.fields.Servicio,
      idSupabase: c.fields.ID_Supabase,
      telefono: c.fields.Teléfono
    }));

    const inicioDia = `${fecha}T00:00:00-05:00`;
    const finDia = `${fecha}T23:59:59-05:00`;

    const { data: citasSupabase } = await supabase
      .from('citas')
      .select('id, fecha_hora, especialista_id, duracion_aux, servicio_aux, estado, nombre_cliente_aux')
      .eq('estado', 'Confirmada')
      .gte('fecha_hora', inicioDia)
      .lte('fecha_hora', finDia);

    const { data: especialistasData } = await supabase
      .from('especialistas')
      .select('id, nombre');

    const mapaEspecialistas = {};
    (especialistasData || []).forEach(e => { mapaEspecialistas[e.id] = e.nombre; });

    const mapa = new Map();

    citasAirtable.forEach(c => {
      const key = `${c.hora}|${c.especialista}`;
      mapa.set(key, c);
    });

    (citasSupabase || []).forEach(c => {
      const hora = c.fecha_hora ? c.fecha_hora.substring(11, 16) : null;
      const nombreEsp = mapaEspecialistas[c.especialista_id] || 'Asignar';
      if (hora) {
        const key = `${hora}|${nombreEsp}`;
        if (!mapa.has(key)) {
          mapa.set(key, {
            hora,
            duracion: c.duracion_aux || 60,
            especialista: nombreEsp,
            servicio: c.servicio_aux,
            idSupabase: c.id
          });
        }
      }
    });

    return Array.from(mapa.values());
  } catch (error) {
    console.error('Error obteniendo citas del día:', error.message);
    return [];
  }
}

async function verificarDisponibilidad(fecha, hora, especialistaSolicitado, duracionMinutos) {
  const citas = await obtenerCitasDelDia(fecha);

  const [h, m] = hora.split(':').map(Number);
  const inicioNuevo = h * 60 + m;
  const finNuevo = inicioNuevo + (duracionMinutos || 60);

  if (inicioNuevo < 540) {
    return { ok: false, mensaje: "Nuestro horario comienza a las 9:00 a.m. 🌅" };
  }
  if (finNuevo > 1080) {
    return { ok: false, mensaje: "Ese horario excede nuestra jornada (hasta las 6:00 p.m.). ¿Te funciona más temprano?" };
  }

  for (const cita of citas) {
    if (!cita.hora) continue;
    const [he, me] = cita.hora.split(':').map(Number);
    const inicioExistente = he * 60 + me;
    const finExistente = inicioExistente + (cita.duracion || 60);

    if (inicioNuevo < finExistente && finNuevo > inicioExistente) {
      if (!especialistaSolicitado || cita.especialista === especialistaSolicitado) {
        return {
          ok: false,
          mensaje: `Ups, ${cita.especialista || 'ese horario'} ya está ocupado${cita.servicio ? ` con un ${cita.servicio}` : ''}. 😔`,
          conflictoCon: cita
        };
      }
    }
  }

  return { ok: true, especialista: especialistaSolicitado || 'Asignar' };
}

async function buscarAlternativa(fecha, horaSolicitada, especialistaSolicitado, duracion) {
  const citas = await obtenerCitasDelDia(fecha);
  const [h, m] = horaSolicitada.split(':').map(Number);

  let horaPropuesta = h * 60 + m;

  while (horaPropuesta <= 1080 - duracion) {
    let conflicto = false;

    for (const cita of citas) {
      if (!cita.hora) continue;
      const [ho, mo] = cita.hora.split(':').map(Number);
      const inicioOcupado = ho * 60 + mo;
      const finOcupado = inicioOcupado + (cita.duracion || 60);

      if (horaPropuesta < finOcupado && (horaPropuesta + duracion) > inicioOcupado) {
        if (!especialistaSolicitado || cita.especialista === especialistaSolicitado) {
          conflicto = true;
          break;
        }
      }
    }

    if (!conflicto) {
      const horaStr = `${Math.floor(horaPropuesta/60).toString().padStart(2,'0')}:${(horaPropuesta%60).toString().padStart(2,'0')}`;
      return { mensaje: `¿Qué tal a las ${formatearHora(horaStr)}?`, hora: horaStr };
    }

    horaPropuesta += 15;
  }

  return { mensaje: "Ese día ya no tenemos cupos disponibles. ¿Te parece otro día? 📅" };
}

// ═══════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('<Response></Response>');
  }

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From ? From.replace('whatsapp:', '').trim() : 'test-user';

  try {
    let textoUsuario = Body || "";

    if (MediaUrl0) {
      try {
        const deepgramRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es",
          { url: MediaUrl0 },
          {
            headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 15000
          }
        );
        textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
      } catch (error) {
        console.error('Error Deepgram:', error.message);
      }
    }

    // ── Cargar datos reales de Supabase ──
    let { data: cliente } = await supabase
      .from('clientes')
      .select('id, telefono, nombre, apellido, email, fecha_nacimiento, especialista_pref_id, notas_bienestar')
      .eq('telefono', userPhone)
      .maybeSingle();

    const { data: especialistas } = await supabase
      .from('especialistas')
      .select('id, nombre, rol, expertise, local_id');

    const { data: servicios } = await supabase
      .from('servicios')
      .select('id, nombre, precio, duracion, categoria, descripcion_voda');

    const esNuevo = !cliente?.nombre;

    let historialFiltrado = [];
    if (!esNuevo) {
      const { data: mensajes } = await supabase
        .from('conversaciones')
        .select('rol, contenido')
        .eq('telefono', userPhone)
        .order('created_at', { ascending: false })
        .limit(8);
      if (mensajes) historialFiltrado = mensajes.reverse();
    }

    // ── Construir catálogos reales ──
    const catalogoEspecialistas = (especialistas || [])
      .map(e => `- ${e.nombre}${e.expertise ? ` (${e.expertise})` : ''}${e.rol ? ` — ${e.rol}` : ''}`)
      .join('\n');

    const catalogoServicios = (servicios || [])
      .map(s => `- ${s.nombre}: $${s.precio}, ${s.duracion} min${s.categoria ? ` [${s.categoria}]` : ''}${s.descripcion_voda ? ` — ${s.descripcion_voda}` : ''}`)
      .join('\n');

    const hoy = getFechaEcuador(0);
    const manana = getFechaEcuador(1);
    const pasadoManana = getFechaEcuador(2);

    // ── SYSTEM PROMPT ULTRA-PRECISO ──
    const systemPrompt = `Eres Aura, asistente de AuraSync. Eres una coordinadora humana, cálida, elegante y eficiente. NUNCA eres robótica.

═══════════════════════════════════════════════════════════════
DATOS REALES DEL NEGOCIO — USAR EXACTAMENTE ESTOS, NUNCA INVENTAR:
═══════════════════════════════════════════════════════════════

ESPECIALISTAS DISPONIBLES (solo estos existen):
${catalogoEspecialistas || "(Consultar con recepción)"}

SERVICIOS DISPONIBLES (solo estos existen):
${catalogoServicios || "(Consultar con recepción)"}

═══════════════════════════════════════════════════════════════
REGLAS DE ORO — VIOLARLAS ES UN ERROR CRÍTICO:
═══════════════════════════════════════════════════════════════

1. NUNCA inventes especialistas. Si el cliente pide uno que NO está en la lista, di: "Ese especialista no está disponible, pero te puedo ofrecer a [nombre real de la lista]."

2. NUNCA inventes servicios, precios ni duraciones. Usa EXACTAMENTE los datos de arriba.

3. FLUJO CONVERSACIONAL (una pregunta por mensaje, NUNCA repetitivo):

   Paso 1: Saludo cálido + ¿qué servicio necesita? (SOLO si el cliente NO lo dijo ya)

   Paso 2: Presentar MÍNIMO 2 especialistas con su expertise:
           "Para [servicio] te puedo ofrecer a:
            • [Especialista 1] — [expertise del especialista 1]
            • [Especialista 2] — [expertise del especialista 2]
            ¿Con quién te gustaría agendar?"

   Paso 3: Cuando elija especialista, proponer fecha/hora:
           • Si el cliente YA dijo hora: "Perfecto, te confirmo [especialista] a las [hora] que pediste. ¿Te lo agendo?"
           • Si NO dijo hora: "¿Qué día y hora te funciona? Tengo disponible mañana a las 10:00 o 15:00."

   Paso 4: Esperar confirmación explícita ("sí", "dale", "ok", "agéndalo")

   Paso 5: SOLO entonces ejecutar la acción

4. REGLAS ANTI-REDUNDANCIA (NUNCA violar):
   • Si el cliente dijo "quiero a las 17", NUNCA digas "¿te parece a las 17?". Dilo como hecho: "Te confirmo a las 5:00 p.m."
   • Si el cliente eligió un especialista, NUNCA vuelvas a preguntar "¿con Carlos?"
   • Si el cliente confirmó todo, NUNCA repitas los detalles de nuevo antes de ejecutar.
   • NUNCA saludes, sugieras especialista Y propongas horario en el mismo mensaje.
   • Máximo 3 mensajes de intercambio antes de la confirmación final.

5. Para REAGENDAR:
   • Cuando el cliente diga "quiero cambiar/mover/reagendar mi cita", PRIMERO busca en su historial y dile EXACTAMENTE qué citas tiene:
     "Veo que tienes una cita de [SERVICIO] hoy a las [HORA] con [ESPECIALISTA]. ¿Es esa la que quieres mover?"
   • Si tiene VARIAS citas, pregúntale cuál quiere mover.
   • SOLO cuando confirme CUÁL cita, propón nueva fecha/hora.
   • Espera confirmación de la nueva fecha/hora.
   • SOLO entonces ejecuta reagendar.

6. Para CANCELAR: confirma cuál cita quiere cancelar, luego ejecuta.

7. Mantén mensajes cortos, como WhatsApp real. Máximo 2-3 oraciones por mensaje.

8. Usa emojis con moderación y elegancia. 🌸 ✨ 💫

9. Si no entiendes algo, pregunta amablemente. Nunca asumas.

10. Si el cliente menciona un servicio parecido pero no exacto, sugiere el más cercano de la lista real.

═══════════════════════════════════════════════════════════════
FECHAS DE REFERENCIA:
═══════════════════════════════════════════════════════════════
- Hoy: ${formatearFecha(hoy)} (${hoy})
- Mañana: ${formatearFecha(manana)} (${manana})
- Pasado mañana: ${formatearFecha(pasadoManana)} (${pasadoManana})

═══════════════════════════════════════════════════════════════
FORMATO DATA_JSON (obligatorio al final de CADA respuesta):
═══════════════════════════════════════════════════════════════
DATA_JSON:{
  "accion": "none" | "agendar" | "cancelar" | "reagendar",
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}",
  "cita_fecha": "YYYY-MM-DD",
  "cita_hora": "HH:MM",
  "cita_servicio": "nombre exacto del servicio",
  "cita_especialista": "nombre exacto del especialista o vacío"
}

REGLAS DEL JSON:
- "accion": "agendar" SOLO cuando el cliente CONFIRME explícitamente el horario propuesto.
- "accion": "reagendar" SOLO cuando el cliente CONFIRME explícitamente la nueva fecha/hora.
- "accion": "cancelar" SOLO cuando el cliente CONFIRME explícitamente que quiere cancelar.
- "cita_servicio": debe coincidir EXACTAMENTE con un nombre de la lista de servicios.
- "cita_especialista": debe coincidir EXACTAMENTE con un nombre de la lista de especialistas, o vacío si no importa.`;`;

    // ── Construir mensajes para OpenAI ──
    const messages = [{ role: "system", content: systemPrompt }];

    historialFiltrado.forEach(msg => {
      messages.push({
        role: msg.rol === 'assistant' ? 'assistant' : 'user',
        content: msg.contenido
      });
    });

    messages.push({ role: "user", content: textoUsuario });

    // ── Llamada a OpenAI ──
    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o",
      messages: messages,
      temperature: 0.2,
      max_tokens: 400
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }
    });

    let fullReply = aiRes.data.choices[0].message.content;
    let datosExtraidos = {};
    let accionEjecutada = false;
    let mensajeAccion = '';

    // ── Extraer JSON ──
    const jsonMatch = fullReply.match(/(?:DATA_JSON\s*:?\s*)?(?:\`\`\`json\s*)?(\{[\s\S]*?"accion"[\s\S]*?\})(?:\s*\`\`\`)?/i);

    if (jsonMatch) {
      try {
        datosExtraidos = JSON.parse(jsonMatch[1].trim());
        const textoLower = (textoUsuario || '').toLowerCase();

        let fechaFinal = manana;
        if (textoLower.includes('hoy')) fechaFinal = hoy;
        else if (datosExtraidos.cita_fecha?.match(/^\d{4}-\d{2}-\d{2}$/)) fechaFinal = datosExtraidos.cita_fecha;

        // Guardar cliente nuevo si aplica
        if (datosExtraidos.nombre && esNuevo) {
          await supabase.from('clientes').upsert({
            telefono: userPhone,
            nombre: datosExtraidos.nombre.trim(),
            apellido: datosExtraidos.apellido || ""
          }, { onConflict: 'telefono' });

          const { data: nuevoCliente } = await supabase
            .from('clientes')
            .select('id, telefono, nombre, apellido, email, especialista_pref_id')
            .eq('telefono', userPhone)
            .maybeSingle();
          cliente = nuevoCliente;
        }

        const accion = datosExtraidos.accion || 'none';

        const servicioData = servicios?.find(s =>
          s.nombre.toLowerCase().includes((datosExtraidos.cita_servicio || '').toLowerCase())
        ) || { id: null, nombre: datosExtraidos.cita_servicio || "Servicio", precio: 0, duracion: 60 };

        const especialistaData = especialistas?.find(e =>
          e.nombre.toLowerCase().includes((datosExtraidos.cita_especialista || '').toLowerCase())
        ) || null;

        // ═══════════════════════════════════════════════════════
        // ACCIÓN: AGENDAR
        // ═══════════════════════════════════════════════════════
        if (accion === 'agendar') {
          const tieneHora = datosExtraidos.cita_hora?.match(/^\d{2}:\d{2}$/);

          if (fechaFinal && tieneHora) {
            const disponible = await verificarDisponibilidad(
              fechaFinal,
              datosExtraidos.cita_hora,
              datosExtraidos.cita_especialista,
              servicioData.duracion
            );

            if (!disponible.ok) {
              const alternativa = await buscarAlternativa(
                fechaFinal,
                datosExtraidos.cita_hora,
                datosExtraidos.cita_especialista,
                servicioData.duracion
              );
              mensajeAccion = `${disponible.mensaje} ${alternativa.mensaje}`;
            } else {
              const especialistaFinal = disponible.especialista || datosExtraidos.cita_especialista || "Asignar";
              const especialistaIdFinal = especialistaData?.id || null;

              const { data: citaSupabase, error: insertError } = await supabase
                .from('citas')
                .insert({
                  cliente_id: cliente?.id || null,
                  servicio_id: servicioData.id || null,
                  especialista_id: especialistaIdFinal,
                  fecha_hora: `${fechaFinal}T${datosExtraidos.cita_hora}:00-05:00`,
                  estado: 'Confirmada',
                  nombre_cliente_aux: `${datosExtraidos.nombre || cliente?.nombre || ''} ${datosExtraidos.apellido || cliente?.apellido || ''}`.trim(),
                  servicio_aux: servicioData.nombre,
                  duracion_aux: servicioData.duracion
                })
                .select()
                .single();

              if (insertError) {
                console.error('❌ Error insert Supabase:', insertError);
                mensajeAccion = "Ups, tuve un problema guardando tu cita. ¿Me das un momento? 🙏";
              } else {
                console.log('✅ Supabase creado, ID:', citaSupabase?.id);

                const airtableRes = await crearCitaAirtable({
                  telefono: userPhone,
                  nombre: datosExtraidos.nombre || cliente?.nombre || '',
                  apellido: datosExtraidos.apellido || cliente?.apellido || '',
                  fecha: fechaFinal,
                  hora: datosExtraidos.cita_hora,
                  servicio: servicioData.nombre,
                  especialista: especialistaFinal,
                  precio: servicioData.precio,
                  duracion: servicioData.duracion,
                  supabase_id: citaSupabase?.id || null,
                  email: cliente?.email || null,
                  notas: cliente?.notas_bienestar || null,
                  observaciones: `Agendada por AuraSync`
                });

                if (airtableRes.ok) {
                  mensajeAccion = `✨ ¡Listo! Tu cita para ${servicioData.nombre} está confirmada:\n📅 ${formatearFecha(fechaFinal)}\n⏰ ${formatearHora(datosExtraidos.cita_hora)}\n💇‍♀️ Con ${especialistaFinal}\n💰 $${servicioData.precio}\n\nTe esperamos con mucho cariño. 🌸`;
                } else {
                  mensajeAccion = `✅ Tu cita está guardada en nuestro sistema principal. Te confirmo los detalles:\n📅 ${formatearFecha(fechaFinal)} a las ${formatearHora(datosExtraidos.cita_hora)}\n💇‍♀️ ${servicioData.nombre} con ${especialistaFinal}`;
                }
              }
            }
            accionEjecutada = true;
          }
        }

        // ═══════════════════════════════════════════════════════
        // ACCIÓN: REAGENDAR
        // ═══════════════════════════════════════════════════════
        else if (accion === 'reagendar') {
          const tieneHora = datosExtraidos.cita_hora?.match(/^\d{2}:\d{2}$/);

          if (fechaFinal && tieneHora) {
            const { data: clienteActual } = await supabase
              .from('clientes')
              .select('id, nombre, apellido, email')
              .eq('telefono', userPhone)
              .maybeSingle();

            const clienteId = clienteActual?.id || cliente?.id;
            const clienteNombre = clienteActual?.nombre || cliente?.nombre || datosExtraidos.nombre || '';
            const clienteApellido = clienteActual?.apellido || cliente?.apellido || datosExtraidos.apellido || '';

            // Buscar citas confirmadas del cliente
            let citaAMover = null;
            let todasLasCitas = [];

            if (clienteId) {
              const { data: citasPorId } = await supabase
                .from('citas')
                .select('id, servicio_id, servicio_aux, duracion_aux, fecha_hora, especialista_id, estado')
                .eq('cliente_id', clienteId)
                .eq('estado', 'Confirmada')
                .order('fecha_hora', { ascending: true })
                .limit(10);

              if (citasPorId?.length) todasLasCitas = citasPorId;
            }

            if (!todasLasCitas.length) {
              const nombreBusqueda = `${clienteNombre} ${clienteApellido}`.trim();
              if (nombreBusqueda) {
                const { data: citasPorNombre } = await supabase
                  .from('citas')
                  .select('id, servicio_id, servicio_aux, duracion_aux, fecha_hora, especialista_id, estado')
                  .ilike('nombre_cliente_aux', `%${nombreBusqueda}%`)
                  .eq('estado', 'Confirmada')
                  .order('fecha_hora', { ascending: true })
                  .limit(10);

                if (citasPorNombre?.length) todasLasCitas = citasPorNombre;
              }
            }

            // Resolver nombres de especialistas
            const { data: espData } = await supabase.from('especialistas').select('id, nombre');
            const mapaEsp = {};
            (espData || []).forEach(e => { mapaEsp[e.id] = e.nombre; });

            todasLasCitas = todasLasCitas.map(c => ({
              ...c,
              especialista_nombre: mapaEsp[c.especialista_id] || 'Asignar'
            }));

            if (todasLasCitas.length > 0) {
              if (datosExtraidos.cita_servicio) {
                citaAMover = todasLasCitas.find(c =>
                  c.servicio_aux?.toLowerCase().includes(datosExtraidos.cita_servicio.toLowerCase())
                );
              }
              if (!citaAMover) citaAMover = todasLasCitas[0];
            }

            if (!citaAMover) {
              mensajeAccion = "No encontré citas confirmadas a tu nombre para reagendar. ¿Quieres que agende una nueva? 💫";
            } else {
              const servicioActual = servicios?.find(s => s.id === citaAMover.servicio_id) ||
                { nombre: citaAMover.servicio_aux || "Servicio", duracion: citaAMover.duracion_aux || 60, precio: 0 };

              const especialistaReagendar = datosExtraidos.cita_especialista || citaAMover.especialista_nombre;

              const disponible = await verificarDisponibilidad(
                fechaFinal,
                datosExtraidos.cita_hora,
                especialistaReagendar,
                servicioActual.duracion
              );

              if (!disponible.ok) {
                const alternativa = await buscarAlternativa(
                  fechaFinal,
                  datosExtraidos.cita_hora,
                  especialistaReagendar,
                  servicioActual.duracion
                );
                mensajeAccion = `${disponible.mensaje} ${alternativa.mensaje}`;
              } else {
                const especialistaFinal = disponible.especialista || especialistaReagendar || "Asignar";
                const especialistaIdFinal = especialistas?.find(e => e.nombre === especialistaFinal)?.id || citaAMover.especialista_id || null;
                const fechaAnterior = citaAMover.fecha_hora ? citaAMover.fecha_hora.split('T')[0] : '';
                const horaAnterior = citaAMover.fecha_hora ? citaAMover.fecha_hora.substring(11, 16) : '';

                console.log('🔄 Reagendando cita Supabase ID:', citaAMover.id);
                console.log('   De:', fechaAnterior, horaAnterior);
                console.log('   A:', fechaFinal, datosExtraidos.cita_hora);

                // Actualizar en Supabase
                const { error: updateError } = await supabase
                  .from('citas')
                  .update({
                    fecha_hora: `${fechaFinal}T${datosExtraidos.cita_hora}:00-05:00`,
                    estado: 'Confirmada',
                    especialista_id: especialistaIdFinal,
                    nombre_cliente_aux: `${clienteNombre} ${clienteApellido}`.trim()
                  })
                  .eq('id', citaAMover.id);

                if (updateError) {
                  console.error('❌ Error update Supabase:', updateError);
                  mensajeAccion = "Tuvimos un problema moviendo tu cita. ¿Lo intentamos de nuevo? 🙏";
                } else {
                  console.log('✅ Supabase actualizado');

                  // Actualizar en Airtable con fallback robusto
                  const airtableRes = await actualizarCitaAirtable(citaAMover.id, {
                    fecha: fechaFinal,
                    hora: datosExtraidos.cita_hora,
                    especialista: especialistaFinal,
                    observaciones: `Reagendada de ${fechaAnterior} ${horaAnterior}`,
                    telefono: userPhone,
                    fechaAnterior: fechaAnterior,
                    horaAnterior: horaAnterior,
                    especialistaAnterior: citaAMover.especialista_nombre
                  });

                  if (airtableRes.ok) {
                    mensajeAccion = `✨ ¡Cita movida con éxito!\n\nDe: ${formatearFecha(fechaAnterior)} ${formatearHora(horaAnterior)}\nA: 📅 ${formatearFecha(fechaFinal)} a las ${formatearHora(datosExtraidos.cita_hora)}\n💇‍♀️ Con ${especialistaFinal}\n\n¡Nos vemos pronto! 🌸`;
                  } else {
                    console.error('⚠️ Airtable falló pero Supabase sí se actualizó');
                    mensajeAccion = `✅ Tu cita fue movida en nuestro sistema principal a ${formatearFecha(fechaFinal)} a las ${formatearHora(datosExtraidos.cita_hora)}.\n\nNota: Estamos sincronizando con nuestro calendario secundario, pero tu lugar está asegurado. 💫`;
                  }
                }
              }
            }
            accionEjecutada = true;
          }
        }

        // ═══════════════════════════════════════════════════════
        // ACCIÓN: CANCELAR
        // ═══════════════════════════════════════════════════════
        else if (accion === 'cancelar') {
          const clienteId = cliente?.id;
          const clienteNombre = cliente?.nombre || datosExtraidos.nombre || '';
          const clienteApellido = cliente?.apellido || datosExtraidos.apellido || '';

          let citaACancelar = null;
          let todasLasCitas = [];

          if (clienteId) {
            const { data: citasPorId } = await supabase
              .from('citas')
              .select('id, servicio_aux, fecha_hora, especialista_id')
              .eq('cliente_id', clienteId)
              .eq('estado', 'Confirmada')
              .order('fecha_hora', { ascending: true })
              .limit(10);

            if (citasPorId?.length) todasLasCitas = citasPorId;
          }

          if (!todasLasCitas.length) {
            const nombreBusqueda = `${clienteNombre} ${clienteApellido}`.trim();
            if (nombreBusqueda) {
              const { data: citasPorNombre } = await supabase
                .from('citas')
                .select('id, servicio_aux, fecha_hora, especialista_id')
                .ilike('nombre_cliente_aux', `%${nombreBusqueda}%`)
                .eq('estado', 'Confirmada')
                .order('fecha_hora', { ascending: true })
                .limit(10);

              if (citasPorNombre?.length) todasLasCitas = citasPorNombre;
            }
          }

          const { data: espDataCancel } = await supabase.from('especialistas').select('id, nombre');
          const mapaEspCancel = {};
          (espDataCancel || []).forEach(e => { mapaEspCancel[e.id] = e.nombre; });

          todasLasCitas = todasLasCitas.map(c => ({
            ...c,
            especialista_nombre: mapaEspCancel[c.especialista_id] || 'Asignar'
          }));

          if (todasLasCitas.length > 0) {
            if (datosExtraidos.cita_servicio) {
              citaACancelar = todasLasCitas.find(c =>
                c.servicio_aux?.toLowerCase().includes(datosExtraidos.cita_servicio.toLowerCase())
              );
            }
            if (!citaACancelar) citaACancelar = todasLasCitas[0];
          }

          if (!citaACancelar) {
            mensajeAccion = "No encontré citas activas a tu nombre para cancelar. ¿Necesitas agendar una? 💫";
          } else {
            const fechaCita = citaACancelar.fecha_hora ? citaACancelar.fecha_hora.split('T')[0] : '';
            const horaCita = citaACancelar.fecha_hora ? citaACancelar.fecha_hora.substring(11, 16) : '';

            const { error: cancelError } = await supabase
              .from('citas')
              .update({
                estado: 'Cancelada',
                motivo_cancelacion: datosExtraidos.motivo || 'Cancelada por cliente via WhatsApp'
              })
              .eq('id', citaACancelar.id);

            if (cancelError) {
              console.error('❌ Error cancel Supabase:', cancelError);
              mensajeAccion = "Tuvimos un problema cancelando tu cita. ¿Me das un momento? 🙏";
            } else {
              await cancelarCitaAirtable(citaACancelar.id, datosExtraidos.motivo || 'Cancelada por cliente', {
                telefono: userPhone,
                fecha: fechaCita,
                hora: horaCita,
                especialista: citaACancelar.especialista_nombre
              });

              mensajeAccion = `✅ Tu cita de ${citaACancelar.servicio_aux || 'servicio'} del ${formatearFecha(fechaCita)} con ${citaACancelar.especialista_nombre} ha sido cancelada.\n\nLamentamos no verte esta vez, pero aquí estaremos cuando nos necesites. 🌸`;
            }
          }
          accionEjecutada = true;
        }

      } catch (e) {
        console.error('Error procesando JSON:', e.message);
      }
    }

    // ── Limpiar respuesta y guardar conversación ──
    let cleanReply = fullReply.split(/DATA_JSON|\`\`\`json/i)[0].trim();

    if (accionEjecutada && mensajeAccion) {
      cleanReply = mensajeAccion;
    }

    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario },
      { telefono: userPhone, rol: 'assistant', contenido: cleanReply }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error General:', err.message);
    return res.status(200).send('<Response><Message>Lo siento, tuve un problemita técnico. ¿Me das un segundito? 🌸</Message></Response>');
  }
}
