'use strict';
/**
 * Offline Hindi story generator for the 3D mode. Free and deterministic in structure: it picks an
 * original village story from templates, so no paid text API is needed. The text uses the same
 * "Name: line" dialogue format as the animation parser, and is sized for about 45–60 seconds of narration.
 */

const BOYS = ['रोहन', 'गोलू', 'मोहन', 'आरव'];
const GIRLS = ['मीरा', 'सीमा', 'पिंकी', 'नीलू'];
const ELDERS = ['दादी', 'दादाजी', 'चाचा'];
const PLACES = ['गाँव के बीच वाले आम के पेड़ के नीचे', 'गाँव के बाहर खेत के किनारे पुराने आम के पेड़ के पास', 'गाँव के तालाब के पास वाले आम के पेड़ के नीचे'];
const LESSONS = [
  'सच्ची खुशी बाँटने से बढ़ती है।',
  'मेहनत और ईमानदारी से हर मुश्किल आसान हो जाती है।',
  'दूसरों की मदद करने से मन हल्का रहता है।',
];

function pick(list, seed) {
  return list[Math.abs(seed) % list.length];
}

/** Returns a Hindi story string (about 120–140 words). Only Hindi is supported. */
function generateHindiStory(seed = Date.now()) {
  const s = Math.floor(seed / 7);
  const boy = pick(BOYS, s);
  const girl = pick(GIRLS, s + 1);
  const elder = pick(ELDERS, s + 2);
  const place = pick(PLACES, s + 3);
  const lesson = pick(LESSONS, s + 4);
  return [
    `${place} एक छोटा सा गाँव था, जहाँ ${boy} और ${girl} रोज़ खेलने आते थे।`,
    `एक दिन पेड़ पर पके हुए मीठे आम लटक रहे थे। दोनों की नज़र उन पर पड़ी।`,
    `${boy}: वाह! कितने रसीले आम हैं। चलो, पहले तोड़ते हैं।`,
    `${girl}: रुको ${boy}। पेड़ के नीचे बूढ़े ${elder} बैठे हैं। पहले उनसे पूछ लें।`,
    `${elder}: बेटा, आम तुम्हारे ही हैं, पर उनमें से कुछ बच्चों के लिए भी रख देना।`,
    `${boy} ने शरमाते हुए सिर हिलाया। फिर दोनों ने मिलकर आम तोड़े और बच्चों में बाँट दिए।`,
    `${girl}: देखा ${boy}, मिलकर बाँटने से कितना अच्छा लगता है!`,
    `इस कहानी से हमें सीख मिलती है कि ${lesson}`,
  ].join('\n');
}

module.exports = { generateHindiStory };
