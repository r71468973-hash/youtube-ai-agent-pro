'use strict';
/**
 * Offline Hindi story generator for the 2D cartoon mode. Free: it writes an original village story from templates,
 * so no paid text API is needed. Each part (names, village, plot, lesson) is chosen separately from a hash of
 * the seed, so different seeds give different stories. There are about 20,000 combinations, enough for
 * decades of daily videos. The text uses the "Name: line" dialogue format the animation parser reads, and is
 * sized for about 45–60 seconds of narration.
 */
const crypto = require('crypto');

const BOYS = ['रोहन', 'गोलू', 'मोहन', 'आरव', 'अर्जुन', 'विक्रम'];
const GIRLS = ['मीरा', 'सीमा', 'पिंकी', 'नीलू', 'राधा', 'तारा'];
const ELDERS = ['दादी', 'दादाजी', 'चाचा', 'नानी', 'नानाजी', 'मामा'];
const VILLAGES = ['रामपुर', 'शांतिपुर', 'हरीपुर', 'नीमगाँव', 'चंदनपुर', 'फूलगाँव', 'सुखपुर', 'बरगद गाँव'];
const LESSONS = [
  'सच्ची खुशी बाँटने से बढ़ती है।',
  'मेहनत और ईमानदारी से हर मुश्किल आसान हो जाती है।',
  'दूसरों की मदद करने से मन हल्का रहता है।',
  'धैर्य रखने से हर काम अच्छे से पूरा होता है।',
  'बड़ों की बात सुनना हमेशा फ़ायदेमंद होता है।',
  'छोटी-छोटी मदद भी बड़ा बदलाव ला सकती है।',
];

/** Two bytes of a hash for each choice, so each part is chosen independently of the others. */
function choose(list, bytes, index) {
  const n = bytes[index * 2] * 256 + bytes[index * 2 + 1];
  return list[n % list.length];
}

/** Plot 1: the children share ripe mangoes with the elder. */
function plotMangoes({ boy, girl, elder }) {
  return [
    `गाँव के बीच में एक पुराना आम का पेड़ था, जिस पर पके हुए मीठे आम लटक रहे थे।`,
    `एक दिन ${boy} और ${girl} खेलते-खेलते उस पेड़ के पास पहुँचे। दोनों की नज़र आमों पर पड़ी।`,
    `${boy}: वाह! कितने रसीले आम हैं। चलो, पहले तोड़ते हैं।`,
    `${girl}: रुको ${boy}। पेड़ के नीचे ${elder} बैठे हैं। पहले उनसे पूछ लें।`,
    `${elder}: बेटा, आम तुम्हारे ही हैं, पर उनमें से कुछ बच्चों के लिए भी रख देना।`,
    `${boy} ने शरमाते हुए सिर हिलाया। फिर दोनों ने मिलकर आम तोड़े और बच्चों में बाँट दिए।`,
    `${girl}: देखा ${boy}, मिलकर बाँटने से कितना अच्छा लगता है!`,
  ];
}

/** Plot 2: a goat runs away and the children bring it back calmly. */
function plotGoat({ boy, girl, elder }) {
  return [
    `${boy} और ${girl} रोज़ अपनी बकरी को खेत के किनारे चराने ले जाते थे।`,
    `एक दिन बकरी अचानक रस्सी तोड़कर दूर भाग गई। दोनों उसके पीछे दौड़ पड़े।`,
    `${boy}: अरे, बकरी तो बहुत दूर चली गई! अब क्या करें?`,
    `${girl}: घबराओ मत ${boy}। पहले ${elder} से पूछते हैं, वे रास्ते जानते हैं।`,
    `${elder}: बेटा, बकरी को डराओ मत। धीरे-धीरे प्यार से बुलाओ, वह खुद लौट आएगी।`,
    `दोनों ने धीरे से आवाज़ लगाई। थोड़ी देर में बकरी उनके पास लौट आई।`,
    `${girl}: देखा ${boy}, धैर्य रखने से काम जल्दी बन जाता है!`,
  ];
}

/** Plot 3: two children help an elder carry a heavy water pot home. */
function plotWaterPot({ boy, girl, elder }) {
  return [
    `${boy} और ${girl} स्कूल से लौटते समय रोज़ गाँव के कुएँ पर रुकते थे।`,
    `एक दिन उन्होंने देखा कि ${elder} पानी का भारी घड़ा उठाने में परेशानी महसूस कर रहे हैं।`,
    `${boy}: ${elder}, लाइए, हम घड़ा घर तक पहुँचा देते हैं।`,
    `${elder}: शाबाश बेटा! भगवान तुम्हारा भला करे।`,
    `${girl}: ${boy}, कल से हम रोज़ मिलकर ऐसे ही मदद करेंगे।`,
    `अगले दिन से गाँव के और बच्चे भी उनके साथ मदद करने आने लगे।`,
  ];
}

/** Plot 4: a kite gets stuck in a tall tree. Patience and teamwork bring it down safely. */
function plotKite({ boy, girl, elder }) {
  return [
    `फागुन की हवा चल रही थी और ${boy} ने अपनी नई पतंग उड़ाई। ${girl} ताली बजा रही थी।`,
    `तभी तेज़ झोंके में पतंग उड़कर गाँव के सबसे ऊँचे नीम पर जा अटकी।`,
    `${boy}: अब क्या होगा? मेरी पतंग तो फँस गई!`,
    `${elder} ने ऊपर देखा और मुस्कुराकर बोले, बेटा, डालों पर चढ़ने से पहले सोचो कि चोट न लगे।`,
    `${girl}: ${boy}, हम रस्सी और लंबा बाँस लाते हैं। ${elder}, आप बताइए कैसे उतारें?`,
    `${elder} के बताए तरीके से ${boy} ने धीरे-धीरे बाँस से पतंग की डोर खींची। आख़िर पतंग नीचे आ गई।`,
    `${boy} ने पतंग को सीने से लगा लिया। ${girl} बोली, वाह! आज पतंग से ज़्यादा मज़ा तो हमारी टीमवर्क में आया।`,
  ];
}

/** Plot 5: the monsoon river rises. The village moves its animals and families to higher ground in time. */
function plotFlood({ boy, girl, elder }) {
  return [
    `बारिश कई दिनों से रुक नहीं रही थी और गाँव के पास की नदी का पानी लगातार बढ़ रहा था।`,
    `${girl} ने देखा कि नदी का पानी खेत की मेड़ तक पहुँच गया है। वह दौड़कर ${boy} के पास गई।`,
    `${girl}: ${boy}, पानी ख़तरे के निशान तक आ गया है। हमें अभी ${elder} को बताना होगा।`,
    `${boy}: चलो, मैं ढोल बजाकर सबको सावधान करता हूँ। बड़े लोग मवेशी ऊँची जगह ले जाएँ!`,
    `${elder}: शाबाश बच्चों! सामान उठाओ, बच्चों को साथ रखो और मंदिर की ऊँची सीढ़ियों पर चलो।`,
    `सब लोग सही समय पर ऊँची जगह पहुँच गए। थोड़ी ही देर में नदी का पानी खेतों में फैल गया।`,
    `${boy}: ${girl}, अगर हमने समय पर शोर न मचाया होता तो कितना नुकसान होता।`,
  ];
}

/** Plot 6: the village well runs dry. Two children find water by listening to a bird's path, and the village shares it. */
function plotWell({ boy, girl, elder }) {
  return [
    `गर्मी के दिनों में गाँव का कुआँ सूखने लगा और सब लोग पानी के लिए परेशान थे।`,
    `${boy} और ${girl} ने ध्यान से देखा कि सुबह-सुबह कुछ पक्षी एक ही दिशा में उड़ रहे हैं।`,
    `${girl}: ${boy}, पक्षी हमेशा पानी की तरफ़ उड़ते हैं। चलो, उनके पीछे चलें।`,
    `पक्षियों के पीछे चलते-चलते दोनों एक हरे भरे नाले तक पहुँचे, जहाँ ज़मीन के नीचे से पानी रिस रहा था।`,
    `${boy}: दादी, देखिए! यहाँ तो पानी है!`,
    `${elder}: शाबाश! अब सब मिलकर इस जगह को खोदो और बर्तनों में पानी लाकर गाँव में बाँटो।`,
    `उस दिन से गाँव ने सीखा कि जल ही जीवन है, और उसे सब मिलकर बचाते हैं।`,
  ];
}

const PLOTS = [plotMangoes, plotGoat, plotWaterPot, plotKite, plotFlood, plotWell];

/**
 * A story with the names removed, so the same plot told with other names is recognised as the same story.
 * Used to stop a repeated story from being made again.
 */
function storySkeleton(story) {
  let text = String(story);
  for (const word of [...BOYS, ...GIRLS, ...ELDERS, ...VILLAGES]) text = text.split(word).join('#');
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Returns a Hindi story string (about 120–140 words). Only Hindi is supported. */
function generateHindiStory(seed = Date.now()) {
  const bytes = crypto.createHash('sha256').update(String(seed)).digest();
  const boy = choose(BOYS, bytes, 0);
  const girl = choose(GIRLS, bytes, 1);
  const elder = choose(ELDERS, bytes, 2);
  const village = choose(VILLAGES, bytes, 3);
  const lesson = choose(LESSONS, bytes, 4);
  const plot = PLOTS[bytes[12] % PLOTS.length];
  const names = { boy, girl, elder };
  const body = plot(names);
  return [
    `${village} एक छोटा सा गाँव था, जहाँ ${boy} और ${girl} रहते थे।`,
    ...body,
    `इस कहानी से हमें सीख मिलती है कि ${lesson}`,
  ].join('\n');
}

module.exports = { generateHindiStory, storySkeleton };
