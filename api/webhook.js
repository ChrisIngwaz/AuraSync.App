import express from 'express';
import { createServer as createViteServer } from 'vite';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const supabase = createClient(process.env.SUPABASE_URL || '', process.env.SUPABASE_KEY || '');

const CONFIG = {
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN,
  AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || 'Citas',
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY
};

const TIMEZONE = 'America/Guayaquil';

// --- FUNCIONES DE APOYO ---

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
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC'
  });
}

// Nueva función para que Aura "vea" la agenda
async function obtenerCitasOcupadasAirtable(fechas) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const formula = `OR(${fechas.map(f => `{Fecha} = '${f}'`).join(',')})`;
    const filter = encodeURIComponent(`AND(${formula}, {Estado} = 'Confirmada')`);
    
    const response = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    
    return response.data.records.map(r => ({
      fecha: r.fields.Fecha,
      hora: r.fields.Hora,
      especialista: r.fields.Especialista,
      servicio: r.fields.Servicio
    }));
  } catch (error) {
    console.error('Error obteniendo citas ocupadas:', error.message);
    return [];
  }
}

async function crearCitaAirtable(datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const [h, min] = datos.hora.split(':').map(Number);
    const [anio, mes, dia] = datos.fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();
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
          "ID_Supabase": datos.supabase_id || null
        }
      }]
    };
    await axios.post(url, payload, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function cancelarCitaAirtable(telefono, citaId) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    const busqueda = await axios.get(`${url}?filterByFormula=${filter}&maxRecords=1`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    if (busqueda.data.records.length === 0) return false;
    
    const record = busqueda.data.records[0];
    const recordId = citaId || record.id;
    const supabaseId = record.fields.ID_Supabase;

    await axios.patch(`${url}`, {
      records: [{ id: recordId, fields: { "Estado": "Cancelada" } }]
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });

    if (supabaseId) {
      await supabase.from('citas').update({ estado: 'Cancelada' }).eq('id', supabaseId);
    }

    return true;
  } catch (error) {
    console.error('Error al cancelar cita:', error.message);
    return false;
  }
}

async function reagendarCitaAirtable(telefono, datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    const busqueda = await axios.get(`${url}?filterByFormula=${filter}&maxRecords=1`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    if (busqueda.data.records.length === 0) return false;
    
    const record = busqueda.data.records[0];
    const recordId = datos.cita_id || record.id;
    const supabaseId = record.fields.ID_Supabase;

    const [h, min] = datos.cita_hora.split(':').map(Number);
    const [anio, mes, dia] = datos.cita_fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();

    await axios.patch(`${url}`, {
      records: [{ id: recordId, fields: { "Fecha": fechaUTC, "Hora": datos.cita_hora, "Estado": "Confirmada" } }]
    }, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' }
    });

    if (supabaseId) {
      await supabase.from('citas').update({ 
        fecha_hora: `${datos.cita_fecha}T${datos.cita_hora}:00-05:00`,
        estado: 'Confirmada' 
      }).eq('id', supabaseId);
    }

    return true;
  } catch (error) {
    console.error('Error al reagendar cita:', error.message);
    return false;
  }
}

async function verificarDisponibilidadAirtable(fecha, hora, especialistaSolicitado, duracionMinutos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada')`);
    const response = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    const citas = response.data.records;
    const [h, m] = hora.split(':').map(Number);
    const inicioNuevo = h * 60 + m;
    const finNuevo = inicioNuevo + (duracionMinutos || 60);
    if (inicioNuevo < 540) return { ok: false, mensaje: "Nuestro horario comienza a las 9:00." };
    if (finNuevo > 1080) return { ok: false, mensaje: "Ese horario excede nuestra jornada." };
    for (const cita of citas) {
      const [he, me] = cita.fields.Hora.split(':').map(Number);
      const inicioExistente = he * 60 + me;
      const finExistente = inicioExistente + (cita.fields['Duración estimada (minutos)'] || 60);
      if (inicioNuevo < finExistente && finNuevo > inicioExistente) {
        if (!especialistaSolicitado || cita.fields.Especialista === especialistaSolicitado) {
          return { ok: false, mensaje: `${cita.fields.Especialista} no está disponible.` };
        }
      }
    }
    return { ok: true, especialista: especialistaSolicitado || 'Asignar' };
  } catch (error) {
    return { ok: true, especialista: especialistaSolicitado };
  }
}

async function buscarAlternativaAirtable(fecha, horaSolicitada, especialistaSolicitado, duracion) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada')`);
    const response = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    const ocupados = response.data.records.map((c) => ({
      hora: c.fields.Hora,
      duracion: c.fields['Duración estimada (minutos)'] || 60,
      especialista: c.fields.Especialista
    }));
    const [h, m] = horaSolicitada.split(':').map(Number);
    let horaPropuesta = h * 60 + m;
    while (horaPropuesta <= 1080 - duracion) {
      let conflicto = false;
      for (const ocup of ocupados) {
        const [ho, mo] = ocup.hora.split(':').map(Number);
        if (horaPropuesta < (ho * 60 + mo + ocup.duracion) && (horaPropuesta + duracion) > (ho * 60 + mo)) {
          if (!especialistaSolicitado || ocup.especialista === especialistaSolicitado) {
            conflicto = true; break;
          }
        }
      }
      if (!conflicto) {
        const horaStr = `${Math.floor(horaPropuesta/60).toString().padStart(2,'0')}:${(horaPropuesta%60).toString().padStart(2,'0')}`;
        return { mensaje: `¿Te funciona a las ${horaStr}?`, hora: horaStr };
      }
      horaPropuesta += 15;
    }
    return { mensaje: "Ese día está completo." };
  } catch (error) {
    return { mensaje: "¿Te funciona otro horario?" };
  }
}

// --- HANDLER PRINCIPAL ---

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.post('/api/whatsapp', async (req, res) => {
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

      let { data: cliente } = await supabase.from('clientes').select('*').eq('telefono', userPhone).maybeSingle();
      const { data: especialistas } = await supabase.from('especialistas').select('nombre, expertise');
      const { data: servicios } = await supabase.from('servicios').select('id, nombre, precio, duracion');

      // Obtener agenda actual para que Aura no se equivoque
      const fechaHoy = getFechaEcuador(0);
      const fechaManana = getFechaEcuador(1);
      const citasOcupadas = await obtenerCitasOcupadasAirtable([fechaHoy, fechaManana]);
      const agendaOcupada = citasOcupadas.map(c => 
        `- ${c.fecha} a las ${c.hora} con ${c.especialista} (${c.servicio})`
      ).join('\n') || "No hay citas registradas para hoy ni mañana.";

      const esNuevo = !cliente?.nombre;
      let historialFiltrado = [];
      if (!esNuevo) {
        const { data: mensajes } = await supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: false }).limit(6);
        if (mensajes) historialFiltrado = mensajes.reverse();
      }

      const listaEsp = especialistas?.map(e => `${e.nombre} (Experto en: ${e.expertise})`).join(', ') || "nuestro equipo";
      const catalogo = servicios?.map(s => `${s.nombre} ($${s.precio}, ${s.duracion} min)`).join(', ') || "servicios";

      const systemPrompt = `Tu nombre es Aura, asistente de élite de AuraSync. Tu comunicación debe ser indistinguible de la de un humano: cálida, elegante, natural y persuasiva.

[IDENTIDAD]
- Tono: Profesional pero cercano, sofisticado y conversacional.
- Personalidad: Eres una concierge de lujo muy humana.

[FLUJO DE CONVERSACIÓN - REGLA DE ORO]
Para que la conversación sea natural, NUNCA hagas más de una cosa a la vez. Sigue este flujo estrictamente:

1. FASE DE DESCUBRIMIENTO: Si el cliente pide cita, saluda cálidamente y pregunta qué servicio busca (si no lo dijo) o sugiere especialistas. NUNCA propongas horarios en este paso.
2. FASE DE PROPUESTA: Una vez elegido el especialista, propón UN SOLO horario concreto y pregunta si le queda bien.
3. FASE DE CONFIRMACIÓN: SOLO cuando el cliente acepte el horario (diga "sí", "dale", "perfecto", etc.), procedes a confirmar.

[RESTRICCIONES CRÍTICAS]
- NUNCA saludes, sugieras especialista y propongas horario en el mismo mensaje.
- NUNCA confirmes la cita (accion: agendar) hasta que el cliente haya dicho que SÍ al horario propuesto.
- Si el cliente aún no confirma el horario, usa "accion": "none".
- Mantén tus respuestas breves, como si estuvieras chateando por WhatsApp.

[CANCELACIONES Y REAGENDAMIENTOS]
- Si el cliente quiere cancelar: Confirma primero si está seguro. Una vez confirmado, usa "accion": "cancelar".
- Si el cliente quiere cambiar su cita: Pregunta por el nuevo horario/día. Sigue el flujo de propuesta y confirmación. Una vez que acepte el nuevo horario, usa "accion": "reagendar".

[RECOMENDACIONES]
- Especialistas: ${listaEsp}
- Servicios: ${catalogo}

[AGENDA ACTUAL - NO OFRECER ESTOS HORARIOS]
${agendaOcupada}

[FECHAS]
- Hoy es: ${formatearFecha(getFechaEcuador())}
- Mañana es: ${formatearFecha(getFechaEcuador(1))}

[DATA_JSON ESTRUCTURA]
Al final de cada respuesta, incluye estrictamente:
DATA_JSON:{
  "accion": "none" | "agendar" | "cancelar" | "reagendar",
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}",
  "cita_fecha": "YYYY-MM-DD",
  "cita_hora": "HH:MM",
  "cita_servicio": "...",
  "cita_especialista": "...",
  "cita_id": "..."
}`;

      const messages = [{ role: "system", content: systemPrompt }];
      historialFiltrado.forEach(msg => {
        messages.push({ role: msg.rol === 'assistant' ? 'assistant' : 'user', content: msg.contenido });
      });
      messages.push({ role: "user", content: textoUsuario });

      const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: "gpt-4o",
        messages: messages,
        temperature: 0.3
      }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

      let fullReply = aiRes.data.choices[0].message.content;
      let datosExtraidos = {};
      let accionEjecutada = false;
      let mensajeAccion = '';
      const jsonMatch = fullReply.match(/(?:DATA_JSON\s*:?\s*)?(?:```json\s*)?(\{[\s\S]*?"accion"[\s\S]*?\})(?:\s*```)?/i);
     
      if (jsonMatch) {
        try {
          datosExtraidos = JSON.parse(jsonMatch[1].trim());
          const textoLower = (textoUsuario || '').toLowerCase();
          
          let fechaFinal = getFechaEcuador(1); 
          if (textoLower.includes('hoy')) fechaFinal = getFechaEcuador(0);
          else if (datosExtraidos.cita_fecha && datosExtraidos.cita_fecha.match(/^\d{4}-\d{2}-\d{2}$/)) fechaFinal = datosExtraidos.cita_fecha;

          if (datosExtraidos.nombre && esNuevo) {
            await supabase.from('clientes').upsert({
              telefono: userPhone,
              nombre: datosExtraidos.nombre.trim(),
              apellido: datosExtraidos.apellido || ""
            }, { onConflict: 'telefono' });
          }

          const accion = datosExtraidos.accion || 'none';
         
          if (accion === 'cancelar') {
            const resultado = await cancelarCitaAirtable(userPhone, datosExtraidos.cita_id);
            mensajeAccion = resultado ? "✅ Cita cancelada exitosamente." : "No encontré citas activas para cancelar.";
            accionEjecutada = true;
          }
          else if (accion === 'reagendar') {
            if (fechaFinal && datosExtraidos.cita_hora) {
              let servicioData = (servicios?.find(s => (datosExtraidos.cita_servicio || '').toLowerCase().includes(s.nombre.toLowerCase())) || { id: null, nombre: "Servicio", precio: 0, duracion: 60 });
              const disponible = await verificarDisponibilidadAirtable(fechaFinal, datosExtraidos.cita_hora, datosExtraidos.cita_especialista, servicioData.duracion);

              if (!disponible.ok) {
                const alternativa = await buscarAlternativaAirtable(fechaFinal, datosExtraidos.cita_hora, datosExtraidos.cita_especialista, servicioData.duracion);
                mensajeAccion = `Ese horario no está disponible para reagendar. ${alternativa.mensaje}`;
              } else {
                const resultado = await reagendarCitaAirtable(userPhone, { ...datosExtraidos, cita_fecha: fechaFinal });
                mensajeAccion = resultado ? `✅ Cita reprogramada para ${formatearFecha(fechaFinal)} a las ${datosExtraidos.cita_hora}.` : "No encontré una cita activa para reprogramar.";
              }
              accionEjecutada = true;
            }
          }
          else if (accion === 'agendar') {
            if (fechaFinal && datosExtraidos.cita_hora) {
              let servicioData = (servicios?.find(s => (datosExtraidos.cita_servicio || '').toLowerCase().includes(s.nombre.toLowerCase())) || { id: null, nombre: "Servicio", precio: 0, duracion: 60 });
              const disponible = await verificarDisponibilidadAirtable(fechaFinal, datosExtraidos.cita_hora, datosExtraidos.cita_especialista, servicioData.duracion);

              if (!disponible.ok) {
                const alternativa = await buscarAlternativaAirtable(fechaFinal, datosExtraidos.cita_hora, datosExtraidos.cita_especialista, servicioData.duracion);
                mensajeAccion = `Ese horario no está disponible. ${alternativa.mensaje}`;
              } else {
                const especialistaFinal = disponible.especialista || datosExtraidos.cita_especialista || "Asignar";
                const { data: citaSupabase } = await supabase.from('citas').insert({
                  cliente_id: cliente?.id || null,
                  servicio_id: servicioData.id || null,
                  fecha_hora: `${fechaFinal}T${datosExtraidos.cita_hora}:00-05:00`,
                  estado: 'Confirmada',
                  nombre_cliente_aux: `${datosExtraidos.nombre || cliente?.nombre} ${datosExtraidos.apellido || cliente?.apellido}`.trim(),
                  servicio_aux: servicioData.nombre,
                  duracion_aux: servicioData.duracion
                }).select().single();

                const citaAirtable = await crearCitaAirtable({
                  telefono: userPhone,
                  nombre: datosExtraidos.nombre || cliente?.nombre,
                  apellido: datosExtraidos.apellido || cliente?.apellido,
                  fecha: fechaFinal,
                  hora: datosExtraidos.cita_hora,
                  servicio: servicioData.nombre,
                  especialista: especialistaFinal,
                  precio: servicioData.precio,
                  duracion: servicioData.duracion,
                  supabase_id: citaSupabase?.id || null
                });

                if (citaAirtable) {
                  mensajeAccion = `✅ Cita confirmada: ${formatearFecha(fechaFinal)} a las ${datosExtraidos.cita_hora} con ${especialistaFinal}.`;
                } else {
                  mensajeAccion = "Error registrando en Airtable.";
                }
              }
              accionEjecutada = true;
            }
          }
        } catch (e) { console.error('Error JSON:', e.message); }
      }

      let cleanReply = fullReply.split(/DATA_JSON|```json/i)[0].trim();
      if (accionEjecutada && mensajeAccion) cleanReply = `${cleanReply}\n\n${mensajeAccion}`;

      await supabase.from('conversaciones').insert([{ telefono: userPhone, rol: 'user', contenido: textoUsuario }, { telefono: userPhone, rol: 'assistant', contenido: cleanReply }]);
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

    } catch (err) {
      console.error('❌ Error:', err.message);
      return res.status(200).send('<Response><Message>Lo siento, tuve un problema. ¿Me repites por favor? 🌸</Message></Response>');
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
