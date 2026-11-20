// Starwright — the About screen: the title menu's "About" entry.
// Says what the game is, tells the history of the game that inspired it (Kerbal Space Program and its sequel), says
// plainly how Starwright was made, and carries the not-affiliated statement and the credits.
//   ABOUT                      the sections, as plain data: [{ id, title, paras: [string | { list: [string] }] }]
//   openAbout(app)             opens the screen; resolves when it is closed
//   installAbout(app)          adds app.about = { open, sections }
// In a paragraph, [label](https://…) is a link. Nothing else is marked up.
// Test hooks: .sw-about (the screen), [data-about="<id>"] (sections).
import { el, showModal } from './dom.js';

export const REPO_URL = 'https://github.com/jsmith0475/Starwright';

export const ABOUT = [
  { id: 'what', title: 'What Starwright is', paras: [
    'Starwright is a rocket-building and orbital-flight game that runs in your browser. You bolt a rocket together in the assembly building, roll it to the pad, fly it to orbit with real orbital mechanics, and go on to the other worlds of its solar system.',
    'It is an original game with its own worlds, its own crew (the Pips), its own parts and its own art. It is free and open source, it runs on your own machine, and nobody can switch it off.',
  ] },
  { id: 'ksp1', title: 'The game that started it: Kerbal Space Program', paras: [
    'Starwright exists because of Kerbal Space Program. KSP began around 2010 as the idea of Felipe Falanghe, a developer at Squad, a media company in Mexico City that had never made a game. The first public version appeared in 2011: a small green crew, a box of rocket parts, and a planet to leave.',
    'It grew in the open for years, shaped by its players and by a huge modding community, and reached version 1.0 in April 2015. Along the way it did something no game had done at that scale: it made real orbital mechanics fun. Players learned, by failing cheerfully, why you burn sideways to stay up, what a transfer window is, and how hard it is to meet another craft in orbit. NASA and the European Space Agency both worked with its makers on missions for the game, and it turned up in classrooms and in the stories of people who went on to work in spaceflight.',
    'In 2017 the game was bought by Take-Two Interactive and published under its Private Division label. Two expansions followed, and the last major update, version 1.12, came in 2021. Kerbal Space Program is still on sale and still played today, and it is still wonderful. If you have never played it, you should.',
  ] },
  { id: 'ksp2', title: 'Kerbal Space Program 2', paras: [
    'A sequel was announced in August 2019, promising colonies, interstellar travel and multiplayer, with a release planned for 2020. Development moved to a new studio, Intercept Games, in 2020, and the date slipped several times.',
    'Kerbal Space Program 2 reached early access in February 2023 with much of what had been promised still to come. A science update followed at the end of that year. In 2024 the studio building it was closed, and the updates stopped with the game unfinished.',
    'For a lot of players that was the end of a long wait. Starwright is not going to bring KSP back, and it is not trying to replace it. It is one way to keep enjoying that same excitement of spaceflight and orbital dynamics, in a game that anyone can open, read and change.',
    'To the people who made Kerbal Space Program: thank you. This exists because of what you started.',
  ] },
  { id: 'made', title: 'How Starwright was made', paras: [
    'Starwright was not written by hand, and it would be wrong to let anyone think so.',
    'It is the result of an extensive collaboration between one person and teams of AI agents. Jerry Smith directed the project: what to build, what it should feel like, what was not good enough, and when it was ready. More than 20 Claude AI agents, working in parallel teams, wrote most of the code, the tests, the physics checks and the documents. A separate team of Grok AI agents, run by Jerry independently of the Claude agents, reviewed the work. Every build was played and judged by a human, and sent back when it fell short.',
    'The physics is checked against textbook orbital mechanics by its own test suite, and the Science entry on the main menu explains the mathematics the game flies by.',
    '"Teams" means teams of AI agents. Nobody at Anthropic or xAI, the companies that make Claude and Grok, worked on Starwright.',
  ] },
  { id: 'legal', title: 'Independent and open', paras: [
    'Starwright is an independent, original game. Its name, worlds, crew, parts, art, sound and code are its own: it uses no characters, art, music or code from any other game. It is not affiliated with or endorsed by the makers of Kerbal Space Program or by SpaceX, and it is not affiliated with or endorsed by Anthropic or xAI. Kerbal Space Program is a trademark of its owner and is named here only to tell its history.',
    `Starwright's code is released under the MIT License. Rendering uses three.js, also MIT licensed. The full source, the manual and the roadmap are at [github.com/jsmith0475/Starwright](${REPO_URL}).`,
  ] },
];

const CSS = `
.sw-modal.sw-about-modal { width: min(860px, 100%); max-height: min(860px, 100%); display: flex; flex-direction: column; }
.sw-modal.sw-about-modal .sw-modal-body { flex: 1; min-height: 0; overflow-y: auto; padding: 22px 34px 26px; }
.sw-about > section { max-width: 720px; margin: 0 auto 22px; }
.sw-about h3 { margin: 0 0 8px; font-size: 19px; line-height: 1.25; color: var(--sw-text); }
.sw-about p { margin: 0 0 10px; font-size: 14.5px; line-height: 1.6; color: var(--sw-dim); }
.sw-about a { color: var(--sw-teal); }
.sw-about section[data-about="legal"] p { font-size: 13px; color: var(--sw-faint); }
`;
let cssDone = false;
function addCss() {
  if (cssDone || typeof document === 'undefined') return;
  cssDone = true;
  document.head.appendChild(el('style', { text: CSS }));
}

/** A paragraph string → child nodes, with [label](https://…) turned into links. */
function inline(text) {
  const out = [];
  const re = /\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(el('a', { text: m[1], attrs: { href: m[2], target: '_blank', rel: 'noopener noreferrer' } }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function openAbout(app) {
  addCss();
  const body = el('div', { class: 'sw-about' }, ...ABOUT.map(s =>
    el('section', { attrs: { 'data-about': s.id } }, el('h3', { text: s.title }), ...s.paras.map(p => el('p', {}, ...inline(p))))));
  return showModal({ title: 'About Starwright', body, wide: true, class: 'sw-about-modal', cancelValue: false, buttons: [{ label: 'Close', value: false }] });
}

/** Adds app.about (the title menu looks for it). */
export function installAbout(app) {
  app.about = { open: () => openAbout(app), sections: ABOUT.map(s => ({ id: s.id, title: s.title })) };
  return app.about;
}
