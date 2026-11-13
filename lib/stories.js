'use strict';
/**
 * Built-in story templates. Each scene carries its narration (Hindi) and an animation spec
 * for lib/animate.py. Cards (intro/outro) are silent and show text via subtitles.
 */

const MORAL = 'मेहनत करने वालों की कभी हार नहीं होती।';

const rahul = {
  id: 'rahul',
  title: 'गरीब लड़के का बड़ा सपना',
  language: 'hi',
  moral: MORAL,
  meta: {
    title: 'गरीब लड़के का बड़ा सपना | Hindi Motivational Story',
    description:
      'गरीब लड़के का बड़ा सपना – एक गाँव के लड़के राहुल की प्रेरणादायक कहानी, जिसने मेहनत और हिम्मत से अपने माता-पिता का नाम रोशन किया।\n\n' +
      MORAL + '\n\n' +
      'अगर कहानी पसंद आई तो लाइक करें और चैनल को सब्सक्राइब करें।\n\n' +
      '#HindiStory #Motivation #प्रेरणादायक #हिंदीकहानी #Inspiration\n\n' +
      'यह वीडियो AI की मदद से बनाया गया है (कहानी, एनिमेशन और आवाज़)।',
    tags: ['hindi motivational story', 'hindi kahani', 'motivational story', 'प्रेरणादायक कहानी', 'हिंदी कहानी', 'garib ladke ka sapna', 'success story hindi', 'moral story hindi'],
  },
  // Scenes: narration is what the voice says. Durations come from the audio (or reading speed).
  scenes: [
    {
      card: { title: 'गरीब लड़के का बड़ा सपना', subtitle: 'एक प्रेरणादायक कहानी' }, silent: true, duration: 2.6, sfx: ['whoosh'],
      anim: { setting: 'card', cam: { z: [1.0, 1.1] }, actors: [{ who: 'rahul', x: 500, act: 'cheer', emo: 'happy' }], props: ['sparkles'] },
    },
    {
      narration: 'एक छोटे से गाँव में रहता था राहुल। उसके पास पैसे नहीं थे, लेकिन आँखों में एक बड़ा सपना था।',
      visual: 'Village at sunrise, Rahul walking on a dirt path',
      sfx: ['whoosh', 'steps'],
      anim: { setting: 'morning', cam: { cx: [380, 620], z: [1.0, 1.12] }, actors: [{ who: 'rahul', x: [200, 700], act: 'walk', emo: 'happy' }] },
    },
    {
      narration: 'वह रोज़ सोचता, एक दिन मैं बड़ा आदमी बनूँगा, और अपने माँ-बाप का नाम रोशन करूँगा।',
      visual: 'Rahul looking up, dreaming of a big city',
      sfx: ['whoosh'],
      anim: { setting: 'sunset', cam: { cx: [500, 470], z: [1.0, 1.18] }, actors: [{ who: 'rahul', x: 420, act: 'stand', emo: 'happy', dir: 1 }], props: ['bubble_city'] },
    },
    {
      narration: 'गाँव के लोग उसका मज़ाक उड़ाते थे। कहते, गरीब का बेटा क्या बनेगा? राहुल का दिल दुखता, पर उसने हार नहीं मानी।',
      visual: 'Villagers laugh at sad Rahul',
      sfx: ['whoosh'],
      anim: {
        setting: 'day', cam: { cx: [520, 470], z: [1.0, 1.14] },
        actors: [
          { who: 'villager1', x: 690, act: 'laugh', emo: 'laugh', dir: -1 },
          { who: 'villager2', x: 835, act: 'laugh', emo: 'laugh', dir: -1 },
          { who: 'rahul', x: 300, act: 'stand', emo: 'sad', dir: 1 },
        ],
      },
    },
    {
      narration: 'दिन में खेत में काम करता, और रात को दीये की रोशनी में पढ़ाई करता।',
      visual: 'Rahul studying at night by a lamp',
      sfx: ['whoosh'],
      anim: { setting: 'night_room', cam: { cx: [480, 520], z: [1.0, 1.2] }, actors: [{ who: 'rahul', x: 480, act: 'study', emo: 'determined', dir: 1 }], props: ['desk'] },
    },
    {
      narration: 'हर सुबह दौड़ लगाता, और खुद से कहता, मैं रुकूँगा नहीं, मैं हारूँगा नहीं।',
      visual: 'Rahul running at dawn, determined',
      sfx: ['whoosh', 'steps'],
      anim: { setting: 'dawn', cam: { cx: [300, 700], z: [1.05, 1.15] }, actors: [{ who: 'rahul', x: [200, 760], act: 'run', emo: 'determined', talk: true }] },
    },
    {
      narration: 'कई बार वह गिरा, कई बार वह रोया, लेकिन हर बार उठकर फिर से मेहनत में जुट गया।',
      visual: 'Rahul sad, then stands up determined',
      sfx: ['whoosh'],
      anim: { setting: 'sunset', cam: { cx: [500, 500], z: [1.2, 1.0] }, actors: [{ who: 'rahul', x: 500, act: 'stand', emo: 'cry', dir: 1, emoTo: 'determined' }] },
    },
    {
      narration: 'आख़िरकार वह दिन आया। राहुल को एक अच्छी नौकरी मिल गई।',
      visual: 'Adult Rahul in a city celebrates with his offer letter',
      sfx: ['whoosh', 'chime'],
      anim: { setting: 'city', cam: { cx: [500, 500], z: [1.0, 1.15] }, actors: [{ who: 'rahul_adult', x: 500, act: 'cheer', emo: 'happy' }], props: ['letter', 'confetti'] },
    },
    {
      narration: 'माँ-बाप की आँखों में खुशी के आँसू थे। और राहुल ने सीखा, मेहनत करने वालों की कभी हार नहीं होती।',
      visual: 'Parents proud, family hugging in front of their home',
      sfx: ['whoosh', 'chime'],
      anim: {
        setting: 'morning', cam: { cx: [500, 500], z: [1.0, 1.15] },
        actors: [
          { who: 'mom', x: 295, act: 'stand', emo: 'joy', dir: 1 },
          { who: 'rahul_adult', x: 500, act: 'stand', emo: 'happy', dir: 1 },
          { who: 'dad', x: 705, act: 'stand', emo: 'joy', dir: -1 },
        ],
        props: ['confetti'],
      },
    },
    {
      card: { title: MORAL, subtitle: 'लाइक और सब्सक्राइब करें' }, silent: true, duration: 4.0, sfx: ['chime'],
      anim: {
        setting: 'card', cam: { z: [1.0, 1.08] },
        actors: [{ who: 'mom', x: 270, act: 'stand', emo: 'joy' }, { who: 'rahul_adult', x: 500, act: 'cheer', emo: 'happy' }, { who: 'dad', x: 730, act: 'stand', emo: 'joy', dir: -1 }],
        props: ['sparkles', 'confetti'],
      },
    },
  ],
};

const STORIES = { rahul };

function get(id) { return STORIES[id] || null; }
function storyText(id) { const s = get(id); return s ? s.scenes.filter((x) => x.narration).map((x) => x.narration).join(' ') : ''; }
function list() { return Object.values(STORIES).map((s) => ({ id: s.id, title: s.title, language: s.language, story: s.scenes.filter((x) => x.narration).map((x) => x.narration).join(' ') })); }

/** Deep-copied scenes so a job can mutate them. */
function buildScenes(id) {
  const s = get(id);
  return s ? JSON.parse(JSON.stringify(s.scenes)) : null;
}

module.exports = { get, list, buildScenes, storyText, MORAL };
