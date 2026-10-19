import { namesMatch } from './domain.mjs';

/** LinkedIn display names carry credentials, titles and nicknames that the
 * register never has. Cleaning is conservative: only trailing credentials,
 * leading civic/religious titles and known nickname-to-formal pairs. Identity
 * is still decided by school evidence, never by a name alone. */
const tokens = value => String(value ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean);

// Trailing-only. Excludes credentials that are also common surnames (Ma, Ba, Pa, He, Do, Le).
const CREDENTIALS = new Set(['rn', 'ren', 'rm', 'en', 'een', 'np', 'cnc', 'cns', 'cne', 'cnm', 'ccrn', 'bn', 'bsn', 'bscn', 'bnurs',
  'bhsc', 'bsc', 'msn', 'mn', 'mnp', 'mnurs', 'mph', 'msc', 'mba', 'mha', 'phd', 'dnp', 'gaicd', 'faicd', 'macn', 'facn', 'macnp',
  'mrcna', 'fracma', 'facm', 'gcnm', 'gdipnur', 'gdip', 'gcert', 'pgdip', 'dipnurs', 'acipm', 'cert', 'iv', 'jp', 'oam', 'am',
  'she', 'her', 'hers', 'they', 'them', 'theirs', 'him', 'his']);
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'mx', 'sir', 'cr', 'councillor', 'sister', 'rev']);

const strip = t => {
  while (t.length > 2 && TITLES.has(t[0])) t.shift();
  while (t.length > 2 && CREDENTIALS.has(t.at(-1))) t.pop();
  return t.join(' ');
};
/** Readings of one display name: every word (brackets ignored), then the part
 * before a comma/bracket. Exports drop closing brackets, so the bracket can hold
 * a surname ("Elvira (elle Reyes", "Grace Dawson (kamau") or credentials
 * ("Obinna AKINOLA, MSc (Critical Care)"); both readings are kept. */
export function personNameVariants(value) {
  const full = strip(tokens(value)), lead = strip(tokens(String(value ?? '').split(/[,(|]/)[0]));
  return [...new Set([lead, full].filter(v => v.split(' ').length >= 2))].concat(full.split(' ').length < 2 && full ? [full] : []);
}
/** The single best display form: the part before a comma/bracket when it is a full name. */
export function cleanPersonName(value) {
  return personNameVariants(value)[0] || '';
}

const FORMAL = {
  jessica: 'jess jessie jessy', katherine: 'kate katie katy kath kathy cath cathy kat kaye', catherine: 'kate katie katy kath kathy cath cathy kat',
  kathryn: 'kate katie katy kath kathy kat', katharine: 'kate katie kath kathy kat', cathryn: 'kate cath cathy', kathleen: 'kath kathy kate katie kat',
  stephanie: 'steph stephie steff', elizabeth: 'liz lizzie lizzy beth betty eliza libby', patricia: 'patty pat trish tricia patsy',
  jacqueline: 'jackie jacqui jacky jac', natalie: 'nat', nathalie: 'nat', natasha: 'nat tash tasha', bernadette: 'bernie', bernard: 'bernie',
  anthony: 'tony ant', andrew: 'andy drew', alexandra: 'alex lexi sasha', alexander: 'alex', samantha: 'sam sammy', samuel: 'sam sammy',
  christine: 'chris chrissy', christina: 'chris chrissy tina', christopher: 'chris', deborah: 'deb debbie debby', debra: 'deb debbie',
  margaret: 'maggie meg marg margie peggy', victoria: 'vicky vicki tori', rebecca: 'bec becky becca bek', rachel: 'rach', amanda: 'mandy',
  melissa: 'mel missy', melanie: 'mel', michelle: 'shell chelle', michael: 'mike mick mikey', william: 'will bill billy liam',
  robert: 'rob bob bobby robbie', richard: 'rich rick richie', james: 'jim jimmy jamie', joseph: 'joe joey', daniel: 'dan danny',
  danielle: 'dani', benjamin: 'ben benny', thomas: 'tom tommy', matthew: 'matt', nicholas: 'nick nic', nicole: 'nic nikki nicky nicki',
  jennifer: 'jen jenny jenn', susan: 'sue suzie susie suzy', suzanne: 'sue suzie suzy', kimberley: 'kim', kimberly: 'kim',
  abigail: 'abby abbie abi', gabrielle: 'gabby gabi', gabriella: 'gabby gabi', isabella: 'bella izzy issy', isabelle: 'bella izzy issy',
  josephine: 'jo josie', joanne: 'jo', joanna: 'jo', johanna: 'jo', charlotte: 'charlie lottie', charles: 'charlie chas',
  frances: 'fran frankie', francesca: 'fran frankie', gillian: 'gill jill', jacinta: 'jac', joshua: 'josh', jonathan: 'jon jono',
  lucinda: 'lucy cindy', madeleine: 'maddy maddie', madeline: 'maddy maddie', madison: 'maddy maddie', megan: 'meg',
  penelope: 'penny pen', philippa: 'pip pippa', phillipa: 'pip pippa', rosemary: 'rose rosie ros', theresa: 'tess terri tessa',
  teresa: 'tess terri tessa', valerie: 'val', veronica: 'ronnie', alison: 'ali', allison: 'ali', ashleigh: 'ash', ashley: 'ash',
  belinda: 'bel belle', bridget: 'bridie', cassandra: 'cass cassie', dominic: 'dom', edward: 'ed eddie ted ned', gregory: 'greg',
  jeffrey: 'jeff', geoffrey: 'geoff', kenneth: 'ken kenny', leonard: 'len lenny', lawrence: 'laurie larry', laurence: 'laurie',
  peter: 'pete', raymond: 'ray', ronald: 'ron ronnie', stephen: 'steve', steven: 'steve', timothy: 'tim timmy', vincent: 'vince vinnie',
  louise: 'lou', louisa: 'lou', dorothy: 'dot dottie', emily: 'em emmy', emma: 'em', georgina: 'georgie gina', georgia: 'georgie',
  priscilla: 'cilla', tamara: 'tam tammy', olivia: 'liv livvy', amelia: 'millie', annabel: 'annie', anne: 'annie', jane: 'janey',
  hannah: 'han', caroline: 'caro', carolyn: 'caro', julianne: 'jules', juliana: 'jules', julia: 'jules', benedict: 'ben',
  zachary: 'zach zac', nathan: 'nate', nathaniel: 'nate nat', jacob: 'jake', sebastian: 'seb', oliver: 'ollie', harrison: 'harry'
};
const formalsOf = new Map();
for (const [formal, nicks] of Object.entries(FORMAL)) for (const nick of nicks.split(' ')) {
  if (!formalsOf.has(nick)) formalsOf.set(nick, new Set());
  formalsOf.get(nick).add(formal);
}
/** Same first name, nickname of the other, or two nicknames of one formal name.
 * Two different formal names (Katherine/Kathleen) never match each other. */
export function firstNamesEquivalent(a, b) {
  if (a === b) return true;
  const fa = formalsOf.get(a), fb = formalsOf.get(b);
  return Boolean(fa?.has(b) || fb?.has(a) || fa && fb && [...fa].some(f => fb.has(f)));
}

/** namesMatch on cleaned names, then once more with the first given name
 * replaced by its register equivalent when it is a known nickname. */
export function personNamesMatch(registerName, displayName) {
  const reg = cleanPersonName(registerName);
  if (!reg) return false;
  const r = reg.split(' ');
  return personNameVariants(displayName).some(shown => {
    if (namesMatch(reg, shown)) return true;
    const s = shown.split(' ');
    if (r.length < 2 || s.length < 2 || r[0] === s[0] || !firstNamesEquivalent(r[0], s[0])) return false;
    return namesMatch(reg, [r[0], ...s.slice(1)].join(' '));
  });
}
