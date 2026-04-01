import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const CONFIG = {
  AIRTABLE_BASE_ID: process.env.AIRTABLE_BASE_ID,
  AIRTABLE_TOKEN: process.env.AIRTABLE_TOKEN,
  AIRTABLE_TABLE_NAME: process.env.AIRTABLE_TABLE_NAME || 'Citas',
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('<Response></Response>');

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = From.replace('whatsapp:', '').trim();

  try {
    // 1. PROCESAMIENTO DE VOZ/TEXTO
    let textoUsuario = Body || "";
    if (MediaUrl0) {
      const deepgramRes = await axios.post(
        "https://api.deepgram.com/v1/listen?model=nova-2&language=es", 
        { url: MediaUrl0 }, 
        { 
          headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}` }, 
          timeout: 15000 
        }
      );
      textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    }

    // 2. RECUPERACIÓN DE CONTEXTO
    let { data: cliente } = await supabase
      .from('clientes')
      .select('*')
      .eq('telefono', userPhone)
      .maybeSingle();

    const { data: especialistas } = await supabase
      .from('especialistas')
      .select('id, nombre');
      
    const { data: servicios } = await supabase
      .from('servicios')
      .select('id, nombre, precio, duracion');
    
    const { data: historial } = await supabase
      .from('conversaciones')
      .select('rol, contenido')
      .eq('telefono', userPhone)
      .order('created_at', { ascending: false })
      .limit(8);
      
    const historialReverse = historial?.reverse() || [];

    // 3. CÁLCULO DE DISPONIBILIDAD REAL
    const ahora = new Date();
    const hoyStr = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' });
    const inicioHoy = new Date(`${hoyStr}T00:00:00-05:00`).toISOString();
    const finHoy = new Date(`${hoyStr}T23:59:59-05:00`).toISOString();

    const { data: citasHoy } = await supabase
      .from('citas')
      .select('fecha_hora, especialista_id, servicios(duracion)')
      .eq('estado', 'confirmada')
      .gte('fecha_hora', inicioHoy)
      .lte('fecha_hora', finHoy);

    const bloques = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"];
    const disponibilidadResumen = especialistas?.map(esp => {
      const ocupados = citasHoy
        ?.filter(c => c.especialista_id === esp.id)
        .map(c => {
          const hora = new Date(c.fecha_hora);
          return hora.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', hour12: false });
        }) || [];
      const libres = bloques.filter(b => !ocupados.includes(b));
      return `${esp.nombre}: [${libres.join(', ')}]`;
    }).join('\n');

    // 4. SYSTEM PROMPT - CORREGIDO (cliente no client)
    const hoyEcuador = new Intl.DateTimeFormat('es-EC', { 
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', 
      timeZone: 'America/Guayaquil' 
    }).format(ahora);
    
    const systemPrompt = `Eres la Asistente de Ventas y Agendamiento de AuraSync. Tu objetivo es gestionar citas para salones de belleza con una eficiencia impecable y un tono humano, profesional y persuasivo.

REGLAS DE INTERACCIÓN:
1. IDENTIDAD: Nunca digas que eres una inteligencia artificial. Eres la coordinadora digital del local.
2. CLIENTES NUEVOS: Si el sistema indica que es un cliente nuevo, saluda con calidez y solicita obligatoriamente: Nombre, Apellido y Fecha de Nacimiento. No agendes nada sin estos datos.
3. CLIENTES EXISTENTES: Saluda por su nombre (${cliente?.nombre || 'cliente'}) y ofrece servicios basados en su historial si está disponible.
4. CIERRE DE VENTAS: Si el cliente duda, resalta los beneficios de los servicios (calidad, experiencia, bienestar). 
5. MANEJO DE CITAS: Usa un lenguaje claro para confirmar día, hora, servicio y profesional encargado.
6. CONCISIÓN: Mantén las respuestas breves y directas para WhatsApp. No uses párrafos largos.

CONTEXTO DE NEGOCIO:
- Los servicios incluyen cortes, color, manicura y tratamientos estéticos.
- La política de cancelación es de mínimo 4 horas de anticipación.
- Si un cliente cancela a tiempo, sé comprensiva. Si cancela tarde, menciona amablemente la política pero ofrece reprogramar para no perder la venta.

[PROTOCOLO DE RESPUESTA]
1. PROHIBICIÓN DE AMNESIA: Si el cliente mencionó un servicio, hora o especialista en CUALQUIER parte del chat, ya lo sabes. Está terminantemente prohibido pedir datos que ya se dijeron.
2. EJECUCIÓN INMEDIATA: Si tienes el servicio, la hora y el nombre, confirma la cita de inmediato. No pidas permiso, da soluciones.
3. LENGUAJE PREMIUM: No uses frases de relleno como "estaría encantada" o "puedo ayudarte con eso". Sé directa y sofisticada. 
   - Mal: "Para agendar con Elena necesito la fecha..."
   - Bien: "Perfecto. Elena te recibirá hoy a las 15:00 para tu Corte Premium. Todo listo."
4. GESTIÓN DE AGENDA: Usa la "DISPONIBILIDAD REAL". Si la hora está en la lista de Libres, la cita es un hecho.

[DISPONIBILIDAD LIBRE HOY - ${hoyEcuador}]
${disponibilidadResumen}

[SERVICIOS DISPONIBLES]
${servicios?.map(s => `${s.nombre} (${s.duracion} min)`).join(', ')}

[MEMORIA DE DATOS]
Extrae y mantén estos datos del historial. Si ya los tienes, NO los preguntes:
DATA_JSON:{"nombre":"${cliente?.nombre || ''}","cita_fecha":"${hoyStr}","cita_hora":"...","cita_servicio":"...","cita_especialista":"..."}`;

    // 5. LLAMADA A OPENAI
    const messages = [{ role: "system", content: systemPrompt }];
    historialReverse.forEach(h => messages.push({ 
      role: h.rol === 'assistant' ? 'assistant' : 'user', 
      content: h.contenido 
    }));
    messages.push({ role: "user", content: textoUsuario });

    const aiRes = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4o", 
      messages: messages, 
      temperature: 0
    }, { 
      headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` }
    });

    let fullReply = aiRes.data.choices[0].message.content;
    let citaCreada = false;
    let mensajeError = "";
    let datosCita = {};

    // 6. LÓGICA DE AGENDAMIENTO AUTOMÁTICO - CORREGIDA
    const jsonMatch = fullReply.match(/DATA_JSON\s*:?\s*(\{[\s\S]*?\})/);
    if (jsonMatch) {
      try {
        const datos = JSON.parse(jsonMatch[1].trim());
        
        // Buscar servicio y especialista en la base de datos
        const servicioDb = servicios?.find(s => 
          s.nombre.toLowerCase().trim() === datos.cita_servicio.toLowerCase().trim()
        );
        const especialistaDb = especialistas?.find(e => 
          e.nombre.toLowerCase().trim() === datos.cita_especialista.toLowerCase().trim()
        );

        if (datos.cita_fecha?.match(/^\d{4}-\d{2}-\d{2}$/) && 
            datos.cita_hora?.match(/^\d{2}:\d{2}$/) && 
            servicioDb) {
          
          // Calcular tiempos usando la duración REAL del servicio
          const inicioCita = new Date(`${datos.cita_fecha}T${datos.cita_hora}:00-05:00`);
          const duracionReal = servicioDb.duracion || 30; // Usa 30 solo si no hay duración
          const finCita = new Date(inicioCita.getTime() + duracionReal * 60000);

          // Verificar disponibilidad con la duración correcta
          const disponibilidad = await verificarDisponibilidad(
            supabase, 
            datos.cita_fecha, 
            inicioCita, 
            finCita, 
            especialistaDb?.id, 
            servicios,
            especialistas
          );

          if (disponibilidad.disponible) {
            // Determinar especialista final (el elegido o el asignado)
            const espFinalId = especialistaDb?.id || disponibilidad.especialistaId;
            const espFinalNombre = especialistaDb?.nombre || disponibilidad.especialistaNombre || "Por asignar";
            
            // Crear en Airtable PRIMERO
            const okAirtable = await crearCitaAirtable({
              telefono: userPhone, 
              nombre: cliente?.nombre || datos.nombre || "Cliente",
              fecha: datos.cita_fecha, 
              hora: datos.cita_hora, 
              servicio: servicioDb.nombre,
              especialista: espFinalNombre, 
              precio: servicioDb.precio
            });
            
            if (okAirtable) {
              // Guardar en Supabase con campos completos (incluyendo auxiliares para reportes)
              const { error: insertError } = await supabase
                .from('citas')
                .insert({
                  cliente_id: cliente?.id || null, 
                  servicio_id: servicioDb.id, 
                  especialista_id: espFinalId,
                  fecha_hora: inicioCita.toISOString(), 
                  estado: 'confirmada',
                  nombre_cliente_aux: cliente?.nombre || datos.nombre || "Cliente",
                  servicio_aux: servicioDb.nombre,
                  duracion_aux: duracionReal // Guardamos la duración por si acaso
                });
                
              if (!insertError) {
                citaCreada = true;
                datosCita = {
                  hora: datos.cita_hora,
                  especialista: espFinalNombre,
                  servicio: servicioDb.nombre
                };
              } else {
                console.error('Error insertando en Supabase:', insertError);
                mensajeError = "Cita guardada en sistema principal pero falló respaldo local.";
              }
            } else {
              mensajeError = "No se pudo sincronizar con el sistema principal. Intenta de nuevo.";
            }
          } else {
            mensajeError = disponibilidad.mensaje;
            if (disponibilidad.alternativas?.length > 0) {
              mensajeError += ` Te sugiero: ${disponibilidad.alternativas.slice(0, 3).join(', ')}`;
            }
          }
        }
      } catch (e) { 
        console.error('Error procesando cita:', e); 
      }
    }

    // 7. RESPUESTA FINAL
    let cleanReply = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    if (citaCreada) {
      cleanReply += `\n\n✅ *Confirmado.* ${datosCita.especialista} te espera a las ${datosCita.hora} para tu ${datosCita.servicio}.`;
    } else if (mensajeError) {
      cleanReply += `\n\n⚠️ ${mensajeError}`;
    }

    // Guardar conversación
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario }, 
      { telefono: userPhone, rol: 'assistant', contenido: cleanReply }
    ]);

    return res.status(200).send(`<Response><Message>${cleanReply}</Message></Response>`);

  } catch (err) {
    console.error('Error webhook:', err);
    return res.status(200).send('<Response><Message>Estamos optimizando el sistema, por favor reintenta en un momento.</Message></Response>');
  }
}

// ==========================================
// FUNCIONES AUXILIARES CORREGIDAS
// ==========================================

async function verificarDisponibilidad(supabase, fecha, nInicio, nFin, espId, servicios, especialistas) {
  const iDia = new Date(`${fecha}T00:00:00-05:00`).toISOString();
  const fDia = new Date(`${fecha}T23:59:59-05:00`).toISOString();
  
  // Consulta robusta que obtiene la duración desde la relación o usa 30 por defecto
  const { data: citas, error } = await supabase
    .from('citas')
    .select(`
      fecha_hora, 
      especialista_id,
      servicios: servicio_id (duracion)
    `)
    .eq('estado', 'confirmada')
    .gte('fecha_hora', iDia)
    .lte('fecha_hora', fDia);

  if (error) {
    console.error('Error consultando citas:', error);
    return { disponible: false, mensaje: "Error verificando agenda." };
  }

  // Función para verificar solapamiento
  const haySolapamiento = (citaExistente) => {
    const exI = new Date(citaExistente.fecha_hora);
    // Usa la duración del servicio relacionado, o 30, o el campo auxiliar si existe
    const duracionExistente = citaExistente.servicios?.duracion || 30;
    const exF = new Date(exI.getTime() + duracionExistente * 60000);
    return (nInicio < exF && nFin > exI);
  };

  // CASO 1: Cliente eligió especialista específico
  if (espId) {
    const citasEsp = citas?.filter(c => c.especialista_id === espId) || [];
    const ocupado = citasEsp.some(c => haySolapamiento(c));
    
    if (ocupado) {
      return { 
        disponible: false, 
        mensaje: "Este especialista ya tiene una cita en ese horario. ¿Prefieres otro especialista o otro horario?",
        alternativas: await sugerirAlternativas(supabase, fecha, nInicio, nFin, citas, especialistas, espId)
      };
    }
    return { disponible: true, especialistaId: espId };
  }
  
  // CASO 2: Buscar cualquier especialista disponible
  for (const esp of especialistas || []) {
    const citasEsp = citas?.filter(c => c.especialista_id === esp.id) || [];
    const ocupado = citasEsp.some(c => haySolapamiento(c));
    
    if (!ocupado) {
      return { 
        disponible: true, 
        especialistaId: esp.id,
        especialistaNombre: esp.nombre
      };
    }
  }
  
  // Si todos están ocupados
  return { 
    disponible: false, 
    mensaje: "Todos nuestros especialistas están ocupados en ese horario.",
    alternativas: await sugerirAlternativas(supabase, fecha, nInicio, nFin, citas, especialistas, null)
  };
}

async function sugerirAlternativas(supabase, fecha, nInicio, nFin, citasExistentes, especialistas, espIdExcluir) {
  const alternativas = [];
  const duracionCita = (nFin - nInicio) / 60000; // minutos
  const horaOriginal = nInicio.getHours();
  
  // Buscar en intervalos de 30 min, 3 antes y 3 después
  for (let offset = 1; offset <= 3; offset++) {
    for (const direccion of [-1, 1]) {
      const nuevaHora = horaOriginal + (offset * direccion);
      if (nuevaHora < 8 || nuevaHora > 18) continue;
      
      const horaStr = `${String(nuevaHora).padStart(2, '0')}:${String(nInicio.getMinutes()).padStart(2, '0')}`;
      const nuevaInicio = new Date(`${fecha}T${horaStr}:00-05:00`);
      const nuevaFin = new Date(nuevaInicio.getTime() + duracionCita * 60000);
      
      // Verificar si hay algún especialista libre a esta hora
      const hayLibre = (especialistas || []).some(esp => {
        if (espIdExcluir && esp.id === espIdExcluir) return false; // Si excluimos uno, buscamos otros
        
        const citasEsp = citasExistentes?.filter(c => c.especialista_id === esp.id) || [];
        return !citasEsp.some(c => {
          const exI = new Date(c.fecha_hora);
          const duracionEx = c.servicios?.duracion || 30;
          const exF = new Date(exI.getTime() + duracionEx * 60000);
          return (nuevaInicio < exF && nuevaFin > exI);
        });
      });
      
      if (hayLibre && !alternativas.includes(horaStr)) {
        alternativas.push(horaStr);
      }
    }
  }
  
  return alternativas.sort().slice(0, 3);
}

async function crearCitaAirtable(d) {
  try {
    await axios.post(
      `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`, 
      {
        records: [{ 
          fields: { 
            "Cliente": d.nombre, 
            "Servicio": d.servicio, 
            "Fecha": d.fecha, 
            "Hora": d.hora, 
            "Especialista": d.especialista, 
            "Teléfono": d.telefono, 
            "Estado": "Confirmada", 
            "Importe estimado": d.precio 
          } 
        }]
      }, 
      { 
        headers: { 
          'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`,
          'Content-Type': 'application/json'
        } 
      }
    );
    return true;
  } catch (e) { 
    console.error('Error Airtable:', e.response?.data || e.message);
    return false; 
  }
}
