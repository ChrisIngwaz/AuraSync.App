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

const TIMEZONE = 'America/Guayaquil';

// ============ FUNCIONES DE FECHA ============

function getFechaEcuador(offsetDias = 0) {
  const ahora = new Date();
  const opciones = { timeZone: TIMEZONE, year: 'numeric', month: 'numeric', day: 'numeric' };
  const formatter = new Intl.DateTimeFormat('en-US', opciones);
  const parts = formatter.formatToParts(ahora);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  const fecha = new Date(Date.UTC(year, month - 1, day));
  fecha.setUTCDate(fecha.getUTCDate() + offsetDias);
  return fecha.toISOString().split('T')[0];
}

function formatearFecha(fechaISO) {
  if (!fechaISO || !fechaISO.match(/^\d{4}-\d{2}-\d{2}$/)) return fechaISO || 'fecha por confirmar';
  const [anio, mes, dia] = fechaISO.split('-').map(Number);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia, 12, 0, 0));
  return fecha.toLocaleDateString('es-EC', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function formatearHora(hora24) {
  if (!hora24) return '';
  const [h, m] = hora24.split(':').map(Number);
  const periodo = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${periodo}`;
}

// ============ MAPEO DE EXPERTISE ============

const MAPEO_EXPERTISE = {
  'corte': ['corte', 'barbero', 'estilista', 'degradado', 'fade', 'taper', 'peluquero', 'cabello'],
  'tinte': ['color', 'tinte', 'mechas', 'balayage', 'colorista'],
  'manicura': ['manicura', 'manos', 'uñas', 'nail', 'gel', 'acrílico'],
  'pedicura': ['pedicura', 'pies', 'podología', 'spa pies'],
  'facial': ['facial', 'rostro', 'limpieza', 'tratamiento', 'piel'],
  'maquillaje': ['maquillaje', 'makeup', 'social', 'novia', 'evento'],
  'peinado': ['peinado', 'evento', 'volumen', 'recogido', 'ondas']
};

function puedeHacerServicio(especialista, servicioNombre) {
  if (!especialista?.expertise || !servicioNombre) return false;
  const servicioNorm = servicioNombre.toLowerCase();
  const expertiseNorm = especialista.expertise.toLowerCase();
  
  for (const [categoria, keywords] of Object.entries(MAPEO_EXPERTISE)) {
    if (servicioNorm.includes(categoria)) {
      return keywords.some(kw => expertiseNorm.includes(kw));
    }
  }
  return expertiseNorm.includes(servicioNorm) || servicioNorm.includes(expertiseNorm);
}

function generarDescripcionPersuasiva(especialista, servicioNombre) {
  const servicioNorm = servicioNombre.toLowerCase();
  const plantillas = {
    'corte': ["Especialista en cortes estructurales y degradados modernos", "Barbero experto en fades y tapers precisos", "Estilista con ojo para las tendencias actuales"],
    'tinte': ["Colorista experto en balayage y mechas", "Especialista en transformaciones de color", "Artista del color con técnicas de última generación"],
    'manicura': ["Especialista en manicura gel y nail art creativo", "Experto en cuidado de manos y uñas", "Artista en uñas con técnicas de spa"],
    'pedicura': ["Especialista en pedicura spa y cuidado podológico", "Experto en tratamientos de pies con relajación", "Técnico en pedicura terapéutica"],
    'peinado': ["Especialista en peinados de evento con volumen", "Artista en recogidos elegantes y ondas", "Experto en styling con productos premium"],
    'facial': ["Especialista en tratamientos faciales personalizados", "Experto en limpieza profunda e hidratación", "Terapeuta facial con enfoque holístico"],
    'maquillaje': ["Maquillista profesional para eventos sociales", "Especialista en maquillaje de novia", "Artista del maquillaje con técnicas de pasarela"]
  };
  
  for (const [cat, descs] of Object.entries(plantillas)) {
    if (servicioNorm.includes(cat)) {
      const idx = (especialista.id?.length || 0) % descs.length;
      return descs[idx];
    }
  }
  return especialista.expertise || "Especialista certificado";
}

// ============ BASE DE DATOS ============

async function cargarDatos() {
  const [espRes, servRes, clienteRes] = await Promise.all([
    supabase.from('especialistas').select('*'),
    supabase.from('servicios').select('*'),
    supabase.from('clientes').select('*')
  ]);
  return {
    especialistas: espRes.data || [],
    servicios: servRes.data || [],
    clientes: clienteRes.data || []
  };
}

async function obtenerCitasOcupadas(fecha) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Fecha} = '${fecha}', {Estado} = 'Confirmada')`);
    const response = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` },
      timeout: 10000
    });
    return response.data.records.map(r => ({
      hora: r.fields.Hora,
      duracion: r.fields['Duración estimada (minutos)'] || 60,
      especialista: r.fields.Especialista
    }));
  } catch (error) {
    console.error('Error Airtable:', error.message);
    return [];
  }
}

async function buscarCitasUsuario(telefono) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const filter = encodeURIComponent(`AND({Teléfono} = '${telefono}', {Estado} = 'Confirmada')`);
    const res = await axios.get(`${url}?filterByFormula=${filter}`, {
      headers: { 'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}` }
    });
    return res.data.records.map(r => ({
      id: r.id,
      servicio: r.fields.Servicio,
      hora: r.fields.Hora,
      fecha: r.fields.Fecha?.split('T')[0],
      especialista: r.fields.Especialista,
      idSupabase: r.fields.ID_Supabase
    }));
  } catch (e) {
    console.error('Error buscando citas:', e.message);
    return [];
  }
}

// ============ AIRTABLE OPERACIONES ============

async function crearCitaAirtable(datos) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const [h, min] = datos.hora.split(':').map(Number);
    const [anio, mes, dia] = datos.fecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();
    
    const payload = {
      records: [{
        fields: {
          "Cliente": `${datos.nombre} ${datos.apellido || ''}`.trim(),
          "Servicio": datos.servicio,
          "Fecha": fechaUTC,
          "Hora": datos.hora,
          "Especialista": datos.especialista,
          "Teléfono": datos.telefono,
          "Estado": "Confirmada",
          "Importe estimado": datos.precio,
          "Duración estimada (minutos)": datos.duracion,
          "ID_Supabase": datos.supabase_id
        }
      }]
    };
    
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    return { ok: true, airtableId: response.data.records[0].id };
  } catch (error) {
    console.error('Error Airtable:', error.response?.data || error.message);
    return { ok: false };
  }
}

async function actualizarEstadoCitaAirtable(airtableId, nuevoEstado) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    await axios.patch(url, {
      records: [{
        id: airtableId,
        fields: { "Estado": nuevoEstado }
      }]
    }, {
      headers: {
        'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    return true;
  } catch (error) {
    console.error('Error actualizando Airtable:', error.message);
    return false;
  }
}

async function reagendarCitaAirtable(airtableId, nuevaFecha, nuevaHora, nuevoEspecialista = null) {
  try {
    const url = `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE_NAME)}`;
    const [h, min] = nuevaHora.split(':').map(Number);
    const [anio, mes, dia] = nuevaFecha.split('-').map(Number);
    const fechaUTC = new Date(Date.UTC(anio, mes - 1, dia, h + 5, min, 0)).toISOString();
    
    const updateData = {
      id: airtableId,
      fields: {
        "Fecha": fechaUTC,
        "Hora": nuevaHora
      }
    };
    
    if (nuevoEspecialista) {
      updateData.fields.Especialista = nuevoEspecialista;
    }
    
    await axios.patch(url, { records: [updateData] }, {
      headers: {
        'Authorization': `Bearer ${CONFIG.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    return true;
  } catch (error) {
    console.error('Error reagendando Airtable:', error.message);
    return false;
  }
}

// ============ VERIFICACIÓN DE DISPONIBILIDAD ============

async function verificarDisponibilidadReal(fecha, hora, duracion, especialistaNombre, citasOcupadas = null) {
  const ocupadas = citasOcupadas || await obtenerCitasOcupadas(fecha);
  
  const [h, m] = hora.split(':').map(Number);
  const inicio = h * 60 + m;
  const fin = inicio + (duracion || 60);
  
  // Validar horario de atención 9 AM - 6 PM
  if (inicio < 540) return { disponible: false, razon: 'horario_cerrado', mensaje: 'Nuestro horario comienza a las 9:00 AM. ¿Te funciona?' };
  if (fin > 1080) return { disponible: false, razon: 'horario_cerrado', mensaje: 'Ese horario excede nuestra jornada (6:00 PM). ¿Otra hora?' };
  
  for (const cita of ocupadas) {
    if (cita.especialista !== especialistaNombre) continue;
    
    const [hc, mc] = cita.hora.split(':').map(Number);
    const inicioExistente = hc * 60 + mc;
    const finExistente = inicioExistente + (cita.duracion || 60);
    
    if (inicio < finExistente && fin > inicioExistente) {
      return {
        disponible: false,
        razon: 'conflicto',
        conflicto: cita,
        mensaje: `${especialistaNombre} no está disponible a las ${formatearHora(hora)}. Tiene otra cita.`
      };
    }
  }
  
  return { disponible: true };
}

async function buscarAlternativas(fecha, horaPreferida, duracion, especialistaNombre, limite = 3) {
  const citasOcupadas = await obtenerCitasOcupadas(fecha);
  const ocupadasEspecialista = citasOcupadas.filter(c => c.especialista === especialistaNombre);
  
  const alternativas = [];
  const [hPref, mPref] = horaPreferida.split(':').map(Number);
  const minutosPref = hPref * 60 + mPref;
  
  // Buscar antes y después de la hora preferida
  const rangos = [
    { inicio: 540, fin: minutosPref }, // Antes
    { inicio: minutosPref + duracion, fin: 1080 - duracion } // Después
  ];
  
  for (const rango of rangos) {
    for (let min = rango.inicio; min <= rango.fin; min += 30) {
      const h = Math.floor(min / 60);
      const m = min % 60;
      const horaStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      
      let libre = true;
      for (const cita of ocupadasEspecialista) {
        const [hc, mc] = cita.hora.split(':').map(Number);
        const inicioC = hc * 60 + mc;
        const finC = inicioC + (cita.duracion || 60);
        
        if (min < finC && (min + duracion) > inicioC) {
          libre = false;
          break;
        }
      }
      
      if (libre) {
        alternativas.push(horaStr);
        if (alternativas.length >= limite) break;
      }
    }
    if (alternativas.length >= limite) break;
  }
  
  return alternativas;
}

// ============ GENERADORES DE MENSAJES ============

function generarSugerenciaEspecialistas(especialistasFiltrados, servicio, fecha, hora, cliente) {
  if (!especialistasFiltrados || especialistasFiltrados.length === 0) {
    return { tipo: 'error', mensaje: "Lo siento, no tenemos especialistas disponibles para ese servicio en este momento." };
  }
  
  const fechaTexto = formatearFecha(fecha);
  const horaTexto = formatearHora(hora);
  
  let mensaje = `¡${cliente?.nombre || 'Hola'}! ✨ Para tu **${servicio.nombre}** el **${fechaTexto}** a las **${horaTexto}**, tengo estas opciones:\n\n`;
  
  const recomendados = especialistasFiltrados.slice(0, 2);
  
  recomendados.forEach((esp, idx) => {
    const label = idx === 0 ? '🥇 Opción recomendada' : '🥈 Alternativa ideal';
    const descripcion = generarDescripcionPersuasiva(esp, servicio.nombre);
    
    mensaje += `${label}:\n**${esp.nombre}** — ${descripcion}\n`;
    mensaje += `✅ Disponible para confirmar\n\n`;
  });
  
  mensaje += `¿Con quién prefieres? Dime el nombre o "primero/segundo" 👇`;
  
  return {
    tipo: 'sugerencia',
    mensaje,
    recomendados: recomendados.map(e => ({ id: e.id, nombre: e.nombre }))
  };
}

// MENSAJE CON CHECK VERDE DOBLE
function mensajeConfirmacion(cliente, servicio, especialista, fecha, hora) {
  return `✅ ¡Confirmado ${cliente?.nombre || ''}! ✅\n\n📅 ${formatearFecha(fecha)} a las ${formatearHora(hora)}\n💇‍♀️ ${servicio.nombre}\n✨ Con ${especialista.nombre}\n\n¡Te esperamos! 😊✨`;
}

function mensajeReagendamiento(fecha, hora, especialista) {
  return `✅ ¡Perfecto! Tu cita ha sido movida para:\n\n📅 ${formatearFecha(fecha)} a las ${formatearHora(hora)}\n👤 Con ${especialista}\n\n¿Algo más en lo que pueda ayudarte?`;
}

function mensajeCancelacion() {
  return `✅ He cancelado tu cita. ¿Te gustaría agendar algo nuevo?`;
}

// ============ HANDLER PRINCIPAL ============

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('<Response></Response>');
  }

  const { Body, From, MediaUrl0 } = req.body;
  const userPhone = (From || '').replace('whatsapp:', '').trim();

  if (!userPhone) {
    return res.status(200).send('<Response></Response>');
  }

  try {
    // 1. PROCESAR AUDIO/TEXTO
    let textoUsuario = Body || "";
    
    if (MediaUrl0) {
      try {
        const deepgramRes = await axios.post(
          "https://api.deepgram.com/v1/listen?model=nova-2&language=es",
          { url: MediaUrl0 },
          {
            headers: { 'Authorization': `Token ${CONFIG.DEEPGRAM_API_KEY}` },
            timeout: 15000
          }
        );
        textoUsuario = deepgramRes.data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
        console.log('🎤 Transcripción:', textoUsuario);
      } catch (error) {
        return res.status(200).send('<Response><Message>Disculpa, no pude escuchar bien. ¿Me escribes? 🎙️</Message></Response>');
      }
    }

    // 2. CARGAR DATOS
    const { especialistas, servicios, clientes } = await cargarDatos();
    const cliente = clientes.find(c => c.telefono === userPhone);
    const citasUsuario = await buscarCitasUsuario(userPhone);
    
    // 3. DETECTAR FECHA EN MENSAJE
    const textoLower = textoUsuario.toLowerCase();
    let fechaDetectada = null;
    
    if (textoLower.includes('mañana') || textoLower.includes('manana')) {
      fechaDetectada = getFechaEcuador(1);
    } else if (textoLower.includes('hoy')) {
      fechaDetectada = getFechaEcuador(0);
    }
    
    // 4. PREPARAR CONTEXTO SIMPLE PARA OPENAI
    const fechaContexto = fechaDetectada || getFechaEcuador(1);
    const fechaHoy = getFechaEcuador(0);
    const fechaManana = getFechaEcuador(1);
    
    const citasInfo = citasUsuario.length > 0
      ? citasUsuario.map(c => `- ${c.servicio} el ${formatearFecha(c.fecha)} a las ${formatearHora(c.hora)}`).join('\n')
      : "Sin citas activas";

    // 5. SYSTEM PROMPT SIMPLIFICADO - SIN DATOS COMPLEJOS QUE CONFUNDAN A LA IA
    const systemPrompt = `Eres Aura, coordinadora de AuraSync. Responde de forma cálida y profesional.

REGLAS:
- Si el usuario dice "mañana", la fecha es ${fechaManana}
- Si dice "hoy", la fecha es ${fechaHoy}
- Servicios: ${servicios.map(s => s.nombre).join(', ')}
- Especialistas: ${especialistas.map(e => e.nombre).join(', ')}

Cuando el usuario quiera agendar, extrae en JSON:
DATA_JSON:{
  "accion": "agendar",
  "cita_fecha": "YYYY-MM-DD",
  "cita_hora": "HH:MM",
  "cita_servicio": "nombre del servicio",
  "cita_especialista": "nombre del especialista o null",
  "nombre": "${cliente?.nombre || ''}",
  "apellido": "${cliente?.apellido || ''}"
}

Citas activas del usuario:
${citasInfo}`;

    // 6. OBTENER HISTORIAL CORTO (solo últimos 4 para no saturar)
    const { data: historial } = await supabase
      .from('conversaciones')
      .select('rol, contenido')
      .eq('telefono', userPhone)
      .order('created_at', { ascending: false })
      .limit(4);
    
    const messages = [{ role: "system", content: systemPrompt }];
    if (historial) {
      historial.reverse().forEach(msg => {
        messages.push({
          role: msg.rol === 'assistant' ? 'assistant' : 'user',
          content: msg.contenido
        });
      });
    }
    messages.push({ role: "user", content: textoUsuario });

    // 7. LLAMAR A OPENAI
    const aiRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: "gpt-4o",
        messages,
        temperature: 0.2,
        max_tokens: 400
      },
      {
        headers: { 'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}` },
        timeout: 10000
      }
    );
    
    let fullReply = aiRes.data.choices[0].message.content;
    console.log('🤖 Respuesta AI:', fullReply.substring(0, 200));
    
    // 8. SEPARAR MENSAJE DE JSON
    let mensajeParaUsuario = fullReply.replace(/DATA_JSON[\s\S]*/, '').trim();
    let datosAccion = null;
    
    const jsonMatch = fullReply.match(/DATA_JSON\s*:\s*(\{[\s\S]*?\})/);
    if (jsonMatch) {
      try {
        datosAccion = JSON.parse(jsonMatch[1].trim());
        console.log('📋 Datos acción:', datosAccion);
      } catch (e) {
        console.error('Error parseando JSON:', e.message);
      }
    }

    // 9. EJECUTAR ACCIONES CON LÓGICA PROPIA, NO DELEGADA A OPENAI
    let resultadoAccion = null;
    
    if (datosAccion && datosAccion.accion === 'agendar') {
      const { cita_fecha, cita_hora, cita_servicio, cita_especialista, nombre, apellido } = datosAccion;
      
      // Usar fecha detectada si OpenAI no la puso bien
      const fechaFinal = cita_fecha || fechaDetectada || getFechaEcuador(1);
      
      // Buscar servicio
      const servicio = servicios.find(s => 
        s.nombre.toLowerCase().includes((cita_servicio || '').toLowerCase())
      );
      
      if (!servicio) {
        resultadoAccion = "No reconocí ese servicio. ¿Podrías repetir? Tenemos: " + servicios.map(s => s.nombre).join(', ');
      } else if (!cita_hora) {
        resultadoAccion = `¿A qué hora te gustaría tu ${servicio.nombre}?`;
      } else {
        // Buscar especialista o sugerir
        let especialista = especialistas.find(e => 
          e.nombre.toLowerCase().includes((cita_especialista || '').toLowerCase())
        );
        
        if (!especialista) {
          // SUGERIR 2 ESPECIALISTAS ALEATORIOS CON EXPERTISE
          let candidatos = especialistas.filter(e => puedeHacerServicio(e, servicio.nombre));
          
          // Completar hasta 2 si hace falta
          if (candidatos.length < 2) {
            const usados = new Set(candidatos.map(c => c.id));
            const extras = especialistas.filter(e => !usados.has(e.id));
            candidatos = [...candidatos, ...extras].slice(0, 2);
          } else {
            candidatos = candidatos.sort(() => Math.random() - 0.5).slice(0, 2);
          }
          
          const sugerencia = generarSugerenciaEspecialistas(candidatos, servicio, fechaFinal, cita_hora, { nombre });
          resultadoAccion = sugerencia.mensaje;
          
          // Guardar estado pendiente
          await supabase.from('conversaciones').insert({
            telefono: userPhone,
            rol: 'system',
            contenido: `PENDIENTE:${JSON.stringify({fecha: fechaFinal, hora: cita_hora, servicio: servicio.nombre})}`,
            created_at: new Date().toISOString()
          });
        } else {
          // VERIFICAR DISPONIBILIDAD Y AGENDAR
          const verificacion = await verificarDisponibilidadReal(fechaFinal, cita_hora, servicio.duracion, especialista.nombre);
          
          if (!verificacion.disponible) {
            // Buscar alternativas de hora
            const alternativas = await buscarAlternativas(fechaFinal, cita_hora, servicio.duracion, especialista.nombre);
            
            if (alternativas.length > 0) {
              resultadoAccion = `${especialista.nombre} no está disponible a las ${formatearHora(cita_hora)}. ¿Te funciona a las ${alternativas.map(formatearHora).join(', ')}?`;
            } else {
              // Sugerir otros especialistas
              const otros = especialistas
                .filter(e => e.id !== especialista.id && puedeHacerServicio(e, servicio.nombre))
                .slice(0, 2);
              
              if (otros.length > 0) {
                const sugerencia = generarSugerenciaEspecialistas(otros, servicio, fechaFinal, cita_hora, { nombre });
                resultadoAccion = `Ese horario está ocupado. ${sugerencia.mensaje}`;
              } else {
                resultadoAccion = "No hay disponibilidad ese día. ¿Otra fecha?";
              }
            }
          } else {
            // AGENDAR: Supabase primero, luego Airtable
            const clienteActual = clientes.find(c => c.telefono === userPhone) || 
              (await supabase.from('clientes').upsert({
                telefono: userPhone,
                nombre: nombre || 'Cliente',
                apellido: apellido || '',
                created_at: new Date().toISOString()
              }, { onConflict: 'telefono' }).select().single()).data;
            
            const { data: citaSupabase, error: errorSupabase } = await supabase
              .from('citas')
              .insert({
                cliente_id: clienteActual?.id,
                servicio_id: servicio.id,
                especialista_id: especialista.id,
                fecha_hora: `${fechaFinal}T${cita_hora}:00-05:00`,
                estado: 'Confirmada',
                created_at: new Date().toISOString()
              })
              .select()
              .single();
            
            if (errorSupabase) {
              resultadoAccion = "Tuve un problema. ¿Me repites?";
            } else {
              const resultadoAirtable = await crearCitaAirtable({
                telefono: userPhone,
                nombre: clienteActual?.nombre || nombre || 'Cliente',
                apellido: clienteActual?.apellido || apellido || '',
                fecha: fechaFinal,
                hora: cita_hora,
                servicio: servicio.nombre,
                especialista: especialista.nombre,
                precio: servicio.precio,
                duracion: servicio.duracion,
                supabase_id: citaSupabase.id
              });
              
              if (resultadoAirtable.ok) {
                resultadoAccion = mensajeConfirmacion(clienteActual || { nombre }, servicio, especialista, fechaFinal, cita_hora);
              } else {
                await supabase.from('citas').delete().eq('id', citaSupabase.id);
                resultadoAccion = "No pude confirmar. ¿Intentamos de nuevo?";
              }
            }
          }
        }
      }
    }
    else if (datosAccion && datosAccion.accion === 'cancelar') {
      const cita = citasUsuario[0];
      if (cita) {
        await actualizarEstadoCitaAirtable(cita.id, 'Cancelada');
        if (cita.idSupabase) {
          await supabase.from('citas').update({ estado: 'Cancelada' }).eq('id', cita.idSupabase);
        }
        resultadoAccion = mensajeCancelacion();
      } else {
        resultadoAccion = "No encontré citas para cancelar.";
      }
    }
    else if (datosAccion && datosAccion.accion === 'reagendar') {
      const cita = citasUsuario.find(c => c.id === datosAccion.cita_id) || citasUsuario[0];
      if (cita && datosAccion.cita_fecha && datosAccion.cita_hora) {
        const ok = await reagendarCitaAirtable(cita.id, datosAccion.cita_fecha, datosAccion.cita_hora, datosAccion.cita_especialista);
        if (ok && cita.idSupabase) {
          await supabase.from('citas').update({
            fecha_hora: `${datosAccion.cita_fecha}T${datosAccion.cita_hora}:00-05:00`
          }).eq('id', cita.idSupabase);
        }
        resultadoAccion = ok ? mensajeReagendamiento(datosAccion.cita_fecha, datosAccion.cita_hora, datosAccion.cita_especialista || cita.especialista) : "No pude reagendar.";
      } else {
        resultadoAccion = "No encontré cita para reagendar.";
      }
    }

    // 10. RESPUESTA FINAL
    if (resultadoAccion) {
      mensajeParaUsuario = resultadoAccion;
    }

    // 11. GUARDAR Y RESPONDER
    await supabase.from('conversaciones').insert([
      { telefono: userPhone, rol: 'user', contenido: textoUsuario, created_at: new Date().toISOString() },
      { telefono: userPhone, rol: 'assistant', contenido: mensajeParaUsuario, created_at: new Date().toISOString() }
    ]);

    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(`<Response><Message>${mensajeParaUsuario}</Message></Response>`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    return res.status(200).send('<Response><Message>Disculpa, tuve un momento. ¿Me repites? 🌸</Message></Response>');
  }
}
