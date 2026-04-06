import express from 'express';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import twilio from 'twilio';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_KEY || ''
);

const CONFIG = {
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN,
  AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || 'Citas',
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER
};

const { MessagingResponse } = twilio.twiml;

// ============ UTILIDADES DE TIEMPO ============

function timeToMinutes(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

/**
 * VERIFICA DISPONIBILIDAD (Corregido y Robusto)
 */
async function verificarDisponibilidad(fecha, hora, especialistaId, duracionMinutos) {
  try {
    if (!especialistaId || especialistaId === '...' || especialistaId === 'Asignar') {
      return { disponible: true, mensaje: null };
    }

    const inicioNueva = timeToMinutes(hora);
    const finNueva = inicioNueva + duracionMinutos;
    const HORA_APERTURA = 540;  // 9:00
    const HORA_CIERRE = 1080;   // 18:00

    if (inicioNueva < HORA_APERTURA || finNueva > HORA_CIERRE) {
      return { 
        disponible: false, 
        mensaje: `Nuestro horario de atención es de 9:00 a 18:00. ¿Te parece bien otro momento?` 
      };
    }

    // Consulta exacta por rango de fecha
    const { data: citasExistentes, error } = await supabase
      .from('citas')
      .select('fecha_hora, duracion_aux, servicio_aux')
      .eq('especialista_id', especialistaId)
      .gte('fecha_hora', `${fecha}T00:00:00`)
      .lte('fecha_hora', `${fecha}T23:59:59`)
      .in('estado', ['Confirmada', 'En proceso']);

    if (error) throw error;

    for (const cita of citasExistentes || []) {
      const horaExistente = cita.fecha_hora.includes('T') ? cita.fecha_hora.split('T')[1].substring(0, 5) : cita.fecha_hora.substring(11, 16);
      const inicioExistente = timeToMinutes(horaExistente);
      const duracionExistente = cita.duracion_aux || 60;
      const finExistente = inicioExistente + duracionExistente;

      if (inicioNueva < finExistente && finNueva > inicioExistente) {
        return {
          disponible: false,
          mensaje: `Ese espacio ya está reservado para una ${cita.servicio_aux}.`
        };
      }
    }

    return { disponible: true, mensaje: null };
  } catch (error) {
    console.error('❌ Error disponibilidad:', error.message);
    return { disponible: false, mensaje: "Tuve un problema al consultar la agenda. Por favor, intenta en un momento." };
  }
}

async function obtenerIdsRelacionales(servicioNombre, especialistaNombre) {
  try {
    let servicioId = null, especialistaId = null, duracion = 60, precio = 0;
    if (servicioNombre && servicioNombre !== '...') {
      const { data: serv } = await supabase.from('servicios').select('id, duracion, precio').ilike('nombre', `%${servicioNombre}%`).maybeSingle();
      if (serv) { servicioId = serv.id; duracion = serv.duracion || 60; precio = serv.precio || 0; }
    }
    if (especialistaNombre && especialistaNombre !== '...' && especialistaNombre !== 'Asignar') {
      const { data: esp } = await supabase.from('especialistas').select('id').ilike('nombre', `%${especialistaNombre}%`).maybeSingle();
      if (esp) especialistaId = esp.id;
    }
    return { servicioId, especialistaId, duracion, precio };
  } catch (error) {
    return { servicioId: null, especialistaId: null, duracion: 60, precio: 0 };
  }
}

async function buscarCitaProxima(clienteId) {
  try {
    const { data } = await supabase
      .from('citas')
      .select('*')
      .eq('cliente_id', clienteId)
      .gte('fecha_hora', new Date().toISOString())
      .in('estado', ['Confirmada', 'En proceso'])
      .order('fecha_hora', { ascending: true })
      .limit(1)
      .maybeSingle();
    return data;
  } catch (error) { return null; }
}

async function actualizarCita(citaId, nuevosDatos) {
  try {
    const fechaHora = `${nuevosDatos.fecha}T${nuevosDatos.hora}:00-05:00`;
    await supabase.from('citas').update({
      servicio_id: nuevosDatos.servicioId,
      especialista_id: nuevosDatos.especialistaId,
      fecha_hora: fechaHora,
      servicio_aux: nuevosDatos.servicio,
      duracion_aux: nuevosDatos.duracion
    }).eq('id', citaId);

    const formula = encodeURIComponent(`AND({Teléfono} = '${nuevosDatos.telefono}', {Estado} = 'Confirmada')`);
    const searchRes = await axios.get(`https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}?filterByFormula=${formula}`, {
      headers: { Authorization: `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });

    if (searchRes.data.records?.length > 0) {
      await axios.patch(`https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}/${searchRes.data.records[0].id}`, {
        fields: {
          "Servicio": nuevosDatos.servicio,
          "Fecha": fechaHora,
          "Hora": nuevosDatos.hora,
          "Especialista": nuevosDatos.especialista,
          "Importe estimado": nuevosDatos.precio,
          "Duración estimada (minutos)": nuevosDatos.duracion
        }
      }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    }
    return { success: true };
  } catch (error) { return { success: false }; }
}

async function cancelarCita(citaId, telefono) {
  try {
    await supabase.from('citas').update({ estado: 'Cancelada' }).eq('id', citaId);
    const formula = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    const searchRes = await axios.get(`https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}?filterByFormula=${formula}`, {
      headers: { Authorization: `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    if (searchRes.data.records?.length > 0) {
      await axios.patch(`https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}/${searchRes.data.records[0].id}`, {
        fields: { "Estado": "Cancelada" }
      }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });
    }
    return { success: true };
  } catch (error) { return { success: false }; }
}

async function registrarCita(datos) {
  try {
    const fechaHora = `${datos.fecha}T${datos.hora}:00-05:00`;
    const { data, error: sError } = await supabase.from('citas').insert({
      cliente_id: datos.clienteId,
      servicio_id: datos.servicioId,
      especialista_id: datos.especialistaId,
      fecha_hora: fechaHora,
      estado: 'Confirmada',
      nombre_cliente_aux: `${datos.nombre} ${datos.apellido}`.trim(),
      servicio_aux: datos.servicio,
      duracion_aux: datos.duracion
    }).select().single();

    if (sError) throw sError;

    await axios.post(`https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`, {
      records: [{
        fields: {
          "ID_Supabase": data.id,
          "Cliente": `${datos.nombre} ${datos.apellido}`.trim(),
          "Servicio": datos.servicio,
          "Fecha": fechaHora,
          "Hora": datos.hora,
          "Especialista": datos.especialista,
          "Teléfono": datos.telefono,
          "Estado": "Confirmada",
          "Importe estimado": datos.precio,
          "Duración estimada (minutos)": datos.duracion
        }
      }]
    }, { headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' } });

    return { success: true, id: data.id };
  } catch (error) { return { success: false }; }
}

// ============ WEBHOOK PRINCIPAL ============

app.get('/webhook', (req, res) => res.status(200).send('AuraSync Active! 🚀'));
app.get('/', (req, res) => res.status(200).send('AuraSync Running! 🚀'));

app.post('*', async (req, res) => {
  console.log('📩 ¡LLEGÓ UN MENSAJE!');
  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From ? From.replace('whatsapp:', '').replace('+', '').trim() : '';
  
  if (!userPhone) return res.status(200).send('<Response></Response>');

  try {
    let textoUsuario = Body || "";
    let finalMessage = "";

    if (MediaUrl0) {
      try {
        const deepgramRes = await axios.post("https://api.deepgram.com/v1/listen?model=nova-2&language=es&smart_format=true&punctuate=true", 
          { url: MediaUrl0 }, 
          { headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' } }
        );
        textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
      } catch (error) {
        finalMessage = "Lo siento, tuve un problema al escuchar tu audio. ¿Podrías escribírmelo?";
      }
    }

    if (!finalMessage) {
      let { data: cliente } = await supabase.from('clientes').select('id, nombre, apellido, fecha_nacimiento').or(`telefono.eq.${userPhone},telefono.eq.+${userPhone}`).maybeSingle();
      const esNuevo = !cliente;
      const perfilIncompleto = cliente && (!cliente.nombre || !cliente.apellido || !cliente.fecha_nacimiento);

      const { data: mensajes } = await supabase.from('conversaciones').select('rol, contenido').eq('telefono', userPhone).order('created_at', { ascending: false }).limit(10);
      const historial = mensajes ? mensajes.reverse() : [];

      const { data: especialistas } = await supabase.from('especialistas').select('nombre, rol, expertise');
      const { data: servicios } = await supabase.from('servicios').select('nombre, precio, duracion');
      const especialistasList = especialistas?.map(e => `- ${e.nombre} (${e.rol}): ${e.expertise}`).join('\n') || "";
      const serviciosList = servicios?.map(s => `${s.nombre} ($${s.precio}, ${s.duracion} min)`).join(', ') || "";

      const hoy = new Intl.DateTimeFormat('es-EC', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Guayaquil' }).format(new Date());

      let systemPrompt = `Eres Aura, la Coordinadora Ejecutiva de AuraSync. Sofisticada, humana y extremadamente eficiente.

[IDENTIDAD]
- Hablas con el titular del número ${userPhone}.
- Perfil: ${cliente ? cliente.nombre + ' ' + cliente.apellido : 'DESCONOCIDO'}.

[REGLAS DE ORO]
1. **SI YA LO CONOCES**: Tienes PROHIBIDO pedirle su nombre, apellido o fecha de nacimiento. Salúdalo y ayuda directo.
2. **SI ES NUEVO**: Pide sus datos (Nombre, Apellido, Fecha de Nacimiento YYYY-MM-DD) antes de agendar.
3. **CITAS PARA TERCEROS**: Si agenda para un hijo o amigo, pregunta el nombre de esa persona para la cita, pero NO intentes registrar un nuevo perfil de cliente. Mantén el perfil del titular intacto.
4. **DISPONIBILIDAD**: Horario 9:00 a 18:00. Si está ocupado, ofrece alternativas reales.

[DATOS]
Especialistas: ${especialistasList}
Servicios: ${serviciosList}
Hoy es ${hoy}.

SALIDA JSON: DATA_JSON:{"accion":"agendar|reagendar|cancelar","nombre":"...","apellido":"...","fecha_nacimiento":"...","cita_fecha":"...","cita_hora":"...","cita_servicio":"...","cita_especialista":"..."}`;

      const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: "gpt-4o",
        messages: [{ role: "system", content: systemPrompt }, ...historial.map((m) => ({ role: m.rol, content: m.contenido })), { role: "user", content: textoUsuario }],
        temperature: 0.3
      }, { headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }});

      let fullReply = aiRes.data.choices[0].message.content;
      finalMessage = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
      const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
      
      if (jsonMatch) {
        try {
          const datos = JSON.parse(jsonMatch[1].trim());
          
          if ((esNuevo || perfilIncompleto) && datos.nombre !== "..." && datos.apellido !== "..." && datos.fecha_nacimiento.match(/^\d{4}-\d{2}-\d{2}$/)) {
            const { data: upserted } = await supabase.from('clientes').upsert({
              telefono: userPhone, nombre: datos.nombre, apellido: datos.apellido, fecha_nacimiento: datos.fecha_nacimiento
            }, { onConflict: 'telefono' }).select().single();
            if (upserted) cliente = upserted;
          }

          if (cliente && !perfilIncompleto && datos.accion) {
            const citaExistente = await buscarCitaProxima(cliente.id);
            if (datos.accion === 'cancelar' && citaExistente) {
              await cancelarCita(citaExistente.id, userPhone);
              finalMessage += `\n\n✅ Cita cancelada con éxito.`;
            } else if (datos.accion === 'reagendar' || datos.accion === 'agendar') {
              if (datos.cita_fecha.match(/^\d{4}-\d{2}-\d{2}$/) && datos.cita_hora.match(/^\d{2}:\d{2}$/)) {
                const ids = await obtenerIdsRelacionales(datos.cita_servicio, datos.cita_especialista);
                const disp = await verificarDisponibilidad(datos.cita_fecha, datos.cita_hora, ids.especialistaId, ids.duracion);

                if (!disp.disponible) {
                  finalMessage += `\n\n${disp.mensaje}`;
                } else {
                  if (datos.accion === 'reagendar' && citaExistente) {
                    await actualizarCita(citaExistente.id, {
                      clienteId: cliente.id, telefono: userPhone,
                      fecha: datos.cita_fecha, hora: datos.cita_hora, servicio: datos.cita_servicio || citaExistente.servicio_aux, especialista: datos.cita_especialista,
                      servicioId: ids.servicioId || citaExistente.servicio_id, especialistaId: ids.especialistaId, duracion: ids.duracion, precio: ids.precio
                    });
                    finalMessage += `\n\n✅ Cita movida al ${datos.cita_fecha} a las ${datos.cita_hora}.`;
                  } else {
                    await registrarCita({
                      clienteId: cliente.id, telefono: userPhone, nombre: cliente.nombre, apellido: cliente.apellido,
                      fecha: datos.cita_fecha, hora: datos.cita_hora, servicio: datos.cita_servicio, especialista: datos.cita_especialista,
                      servicioId: ids.servicioId, especialistaId: ids.especialistaId, duracion: ids.duracion, precio: ids.precio
                    });
                    finalMessage += `\n\n✅ Cita confirmada para el ${datos.cita_fecha} a las ${datos.cita_hora}.`;
                  }
                }
              }
            }
          }
        } catch (e) { console.error('JSON Error'); }
      }
    }

    await supabase.from('conversaciones').insert([{ telefono: userPhone, rol: 'user', contenido: textoUsuario }, { telefono: userPhone, rol: 'assistant', contenido: finalMessage }]);
    const twiml = new MessagingResponse();
    twiml.message(finalMessage);
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml.toString());
  } catch (err) {
    console.error('❌ ERROR:', err.message);
    const twiml = new MessagingResponse();
    twiml.message('Lo siento, tuve un problema técnico. ¿Podrías repetirme eso?');
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml.toString());
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 AuraSync Online`));

export default app;
