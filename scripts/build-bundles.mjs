import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/+$/, '') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? 'dist';
const BUNDLES_DIR = path.join(OUTPUT_DIR, 'bundles');
const BUNDLE_PUBLIC_BASE_URL = resolvePublicBaseUrl();

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const headers = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

function resolvePublicBaseUrl() {
  const explicit = String(process.env.BUNDLE_PUBLIC_BASE_URL ?? '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const repository = String(process.env.GITHUB_REPOSITORY ?? '').trim();
  if (!repository.includes('/')) {
    throw new Error('Missing BUNDLE_PUBLIC_BASE_URL and unable to infer from GITHUB_REPOSITORY');
  }

  const [owner, repo] = repository.split('/');
  return `https://${owner}.github.io/${repo}`;
}

function buildRestUrl(table, query) {
  return `${SUPABASE_URL}/rest/v1/${table}?${query}`;
}

async function fetchTable(table, query) {
  const res = await fetch(buildRestUrl(table, query), { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`REST ${table} failed: ${res.status} ${text}`);
  }
  return await res.json();
}

async function fetchTableWithFallbacks(table, queries) {
  const errors = [];
  for (const q of queries) {
    try {
      return await fetchTable(table, q);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`REST ${table} failed for all query variants:\n${errors.join('\n')}`);
}

async function callRpc(name, body = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RPC ${name} failed: ${res.status} ${text}`);
  }

  return await res.json();
}

function q(select, order) {
  return `select=${select}&order=${order}`;
}

function sortBySortOrderThen(rows, field = 'name') {
  return [...rows].sort((a, b) => {
    const left = Number(a?.sort_order ?? 100);
    const right = Number(b?.sort_order ?? 100);
    if (left !== right) return left - right;
    return String(a?.[field] ?? a?.title ?? '').localeCompare(String(b?.[field] ?? b?.title ?? ''), 'ru');
  });
}

function normalizeOptionalKeys(rows, keys) {
  return rows.map((row) => {
    const next = { ...row };
    for (const key of keys) {
      if (!(key in next)) next[key] = null;
    }
    return next;
  });
}

function withDefaultSortOrder(rows) {
  return rows.map((row, index) => ({
    sort_order: row?.sort_order ?? (index + 1) * 10,
    ...row,
  }));
}

async function buildReferenceBundle() {
  const [
    races,
    subraces,
    factions,
    professions,
    skillCategories,
    skills,
    branches,
    spells,
    libraryEntries,
    npcEntries,
    bestiaryEntries,
    stateDefinitions,
  ] = await Promise.all([
    fetchTableWithFallbacks('races', [
      q('id,name,description,summary,content_html,image_url,sort_order,is_active', 'sort_order.asc.nullslast,name.asc'),
      q('id,name,description,image_url,is_active', 'name.asc'),
    ]),
    fetchTableWithFallbacks('subraces', [
      q('id,race_id,name,description,summary,content_html,image_url,sort_order,is_active', 'sort_order.asc.nullslast,name.asc'),
      q('id,race_id,name,description,image_url,is_active', 'name.asc'),
    ]),
    fetchTableWithFallbacks('factions', [
      q('id,name,description,summary,content_html,image_url,sort_order,is_active', 'sort_order.asc.nullslast,name.asc'),
      q('id,name,description,image_url,is_active', 'name.asc'),
    ]),
    fetchTableWithFallbacks('professions', [
      q('id,name,description,summary,content_html,image_url,sort_order,is_active', 'sort_order.asc.nullslast,name.asc'),
      q('id,name,description,image_url,is_active', 'name.asc'),
    ]),
    fetchTableWithFallbacks('skill_categories', [
      q('id,name,description,summary,content_html,image_url,sort_order,is_active', 'sort_order.asc.nullslast,name.asc'),
      q('id,name,summary,content_html,image_url,sort_order,is_active', 'sort_order.asc.nullslast,name.asc'),
      q('id,name,description,summary,content_html,image_url,is_active', 'name.asc'),
      q('id,name,summary,content_html,image_url,is_active', 'name.asc'),
      q('id,name,image_url,is_active', 'name.asc'),
    ]),
    fetchTableWithFallbacks('skills', [
      q('id,category_id,name,description,summary,content_html,image_url,is_metamagic,sort_order,is_active,required_race_id,required_subrace_id,required_profession_id,required_profession_level', 'sort_order.asc.nullslast,name.asc'),
      q('id,category_id,name,description,image_url,is_metamagic,is_active,required_race_id,required_subrace_id,required_profession_id,required_profession_level', 'name.asc'),
    ]),
    fetchTableWithFallbacks('magic_branches', [
      q('id,name,description,summary,content_html,image_url,sort_order,is_active,required_faction_id,required_reputation_value,is_hidden_until_unlocked', 'sort_order.asc.nullslast,name.asc'),
      q('id,name,description,image_url,is_active,required_faction_id,required_reputation_value,is_hidden_until_unlocked', 'name.asc'),
    ]),
    fetchTableWithFallbacks('spells', [
      q('id,branch_id,name,description,summary,content_html,image_url,sort_order,is_active,required_race_id,required_subrace_id,required_profession_id,required_profession_level', 'sort_order.asc.nullslast,name.asc'),
      q('id,branch_id,name,description,image_url,is_active,required_race_id,required_subrace_id,required_profession_id,required_profession_level', 'name.asc'),
    ]),
    fetchTableWithFallbacks('library_entries', [
      q('id,title,entry_type,summary,content,content_html,image_url,external_url,sort_order,is_published', 'sort_order.asc.nullslast,id.asc'),
      q('id,title,entry_type,summary,content,image_url,external_url,sort_order,is_published', 'sort_order.asc.nullslast,id.asc'),
      q('id,title,entry_type,summary,content,image_url,external_url,is_published', 'id.asc'),
    ]),
    fetchTableWithFallbacks('npc_entries', [
      q('id,name,npc_type,faction_id,summary,description,content,content_html,image_url,external_url,sort_order,is_published', 'sort_order.asc.nullslast,id.asc'),
      q('id,name,npc_type,faction_id,summary,content,content_html,image_url,external_url,sort_order,is_published', 'sort_order.asc.nullslast,id.asc'),
      q('id,name,npc_type,faction_id,summary,description,content,image_url,external_url,is_published', 'id.asc'),
      q('id,name,npc_type,faction_id,summary,content,image_url,external_url,is_published', 'id.asc'),
    ]),
    fetchTableWithFallbacks('bestiary_entries', [
      q('id,name,creature_type,danger_level,summary,description,content,content_html,image_url,external_url,sort_order,is_published', 'sort_order.asc.nullslast,id.asc'),
      q('id,name,creature_type,danger_level,summary,content,content_html,image_url,external_url,sort_order,is_published', 'sort_order.asc.nullslast,id.asc'),
      q('id,name,creature_type,danger_level,summary,description,content,image_url,external_url,is_published', 'id.asc'),
      q('id,name,creature_type,danger_level,summary,content,image_url,external_url,is_published', 'id.asc'),
    ]),
    fetchTableWithFallbacks('state_definitions', [
      q('id,name,summary,description,content_html,image_url,sort_order,is_active', 'sort_order.asc.nullslast,name.asc'),
      q('id,name,summary,content_html,image_url,sort_order,is_active', 'sort_order.asc.nullslast,name.asc'),
      q('id,name,description,summary,content_html,image_url,is_active', 'name.asc'),
      q('id,name,summary,content_html,image_url,is_active', 'name.asc'),
      q('id,name,content_html,image_url,is_active', 'name.asc'),
      q('id,name,image_url,is_active', 'name.asc'),
    ]),
  ]);

  return {
    generated_at: new Date().toISOString(),
    races: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(races), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
    subraces: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(subraces), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
    factions: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(factions), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
    professions: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(professions), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
    skill_categories: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(skillCategories), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
    skills: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(skills), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
    magic_branches: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(branches), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
    spells: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(spells), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
    library_entries: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(libraryEntries), ['entry_type', 'summary', 'content', 'content_html', 'image_url', 'external_url', 'is_published']), 'title'),
    npc_entries: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(npcEntries), ['npc_type', 'faction_id', 'summary', 'description', 'content', 'content_html', 'image_url', 'external_url', 'is_published'])),
    bestiary_entries: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(bestiaryEntries), ['creature_type', 'danger_level', 'summary', 'description', 'content', 'content_html', 'image_url', 'external_url', 'is_published'])),
    state_definitions: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(stateDefinitions), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
  };
}

async function buildContentBundle() {
  const contentPages = await fetchTableWithFallbacks('content_pages', [
    q('id,slug,title,summary,content,content_html,image_url,external_url,sort_order,is_published,updated_at', 'sort_order.asc.nullslast,id.asc'),
    q('id,slug,title,summary,content,image_url,external_url,sort_order,is_published,updated_at', 'sort_order.asc.nullslast,id.asc'),
    q('id,slug,title,summary,content,image_url,external_url,is_published,updated_at', 'id.asc'),
  ]);

  return {
    generated_at: new Date().toISOString(),
    content_pages: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(contentPages), ['content', 'summary', 'content_html', 'image_url', 'external_url', 'is_published', 'updated_at']), 'title'),
  };
}


async function buildWorldPublicBundle() {
  const [achievements, worldEvents, knowledgeHunts, libraryEntries, npcEntries, bestiaryEntries] = await Promise.all([
    fetchTableWithFallbacks('achievements', [
      q('id,title,description,image_url,reward_title', 'id.desc'),
      q('id,title,description,image_url', 'id.desc'),
      q('id,title', 'id.desc'),
    ]),
    fetchTableWithFallbacks('world_events', [
      q('id,title,description,description_html,status,starts_at_text,ends_at_text,impact_note,impact_note_html', 'id.desc'),
      q('id,title,description,status,starts_at_text,ends_at_text,impact_note', 'id.desc'),
      q('id,title,status', 'id.desc'),
    ]),
    fetchTableWithFallbacks('knowledge_hunts', [
      q('id,title,summary_html,content_html,status,target_type,target_id,sort_order,reward_currency,reward_faction_id,reward_reputation_value', 'sort_order.asc.nullslast,id.asc'),
      q('id,title,content_html,status,target_type,target_id,sort_order,reward_currency,reward_faction_id,reward_reputation_value', 'sort_order.asc.nullslast,id.asc'),
      q('id,title,status,target_type,target_id,sort_order', 'sort_order.asc.nullslast,id.asc'),
    ]),
    fetchTableWithFallbacks('library_entries', [
      q('id,title,entry_type,summary,content,content_html,image_url,external_url,sort_order,is_published', 'sort_order.asc.nullslast,id.asc'),
      q('id,title,entry_type,summary,content,image_url,external_url,sort_order,is_published', 'sort_order.asc.nullslast,id.asc'),
      q('id,title,entry_type,summary,content,image_url,external_url,is_published', 'id.asc'),
    ]),
    fetchTableWithFallbacks('npc_entries', [
      q('id,name,npc_type,faction_id,summary,description,content,content_html,image_url,external_url,sort_order,is_published', 'sort_order.asc.nullslast,id.asc'),
      q('id,name,npc_type,faction_id,summary,content,content_html,image_url,external_url,sort_order,is_published', 'sort_order.asc.nullslast,id.asc'),
      q('id,name,npc_type,faction_id,summary,description,content,image_url,external_url,is_published', 'id.asc'),
      q('id,name,npc_type,faction_id,summary,content,image_url,external_url,is_published', 'id.asc'),
    ]),
    fetchTableWithFallbacks('bestiary_entries', [
      q('id,name,creature_type,danger_level,summary,description,content,content_html,image_url,external_url,sort_order,is_published', 'sort_order.asc.nullslast,id.asc'),
      q('id,name,creature_type,danger_level,summary,content,content_html,image_url,external_url,sort_order,is_published', 'sort_order.asc.nullslast,id.asc'),
      q('id,name,creature_type,danger_level,summary,description,content,image_url,external_url,is_published', 'id.asc'),
      q('id,name,creature_type,danger_level,summary,content,image_url,external_url,is_published', 'id.asc'),
    ]),
  ]);

  return {
    generated_at: new Date().toISOString(),
    achievements: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(achievements), ['description', 'image_url', 'reward_title']), 'title'),
    world_events: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(worldEvents), ['description', 'description_html', 'status', 'starts_at_text', 'ends_at_text', 'impact_note', 'impact_note_html']), 'title'),
    knowledge_hunts: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(knowledgeHunts), ['summary', 'description', 'summary_html', 'content_html', 'status', 'target_type', 'target_id', 'reward_currency', 'reward_faction_id', 'reward_reputation_value']), 'title'),
    library_entries: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(libraryEntries), ['entry_type', 'summary', 'content', 'content_html', 'image_url', 'external_url', 'is_published']), 'title'),
    npc_entries: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(npcEntries), ['npc_type', 'faction_id', 'summary', 'description', 'content', 'content_html', 'image_url', 'external_url', 'is_published'])),
    bestiary_entries: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(bestiaryEntries), ['creature_type', 'danger_level', 'summary', 'description', 'content', 'content_html', 'image_url', 'external_url', 'is_published'])),
  };
}

async function buildCharacterCardsBundle() {
  let rows = [];

  try {
    const visibleRows = await callRpc('list_public_approved_character_sheets');
    rows = Array.isArray(visibleRows) ? visibleRows : [];
  } catch (error) {
    // RPC may require end-user auth in some projects; fall back to direct approved rows.
    rows = [];
  }

  const [characters, profiles, characterSkills, skills, characterSpells, spells, characterProfessions, characterStates, stateDefinitions] = await Promise.all([
    fetchTableWithFallbacks('characters', [
      q('id,owner_id,full_name,gender,birth_day,birth_month,birth_year,race_id,subrace_id,faction_id,character_role_id,profession_id,image_url,appearance,appearance_html,biography,biography_html,personality,personality_html,weaknesses,weaknesses_html,status,moderation_note,created_at,updated_at', 'updated_at.desc.nullslast'),
      q('id,owner_id,full_name,gender,birth_day,birth_month,birth_year,race_id,subrace_id,faction_id,character_role_id,profession_id,image_url,appearance,biography,personality,weaknesses,status,moderation_note,created_at,updated_at', 'updated_at.desc.nullslast'),
      q('id,owner_id,full_name,status,updated_at', 'updated_at.desc.nullslast'),
    ]),
    fetchTableWithFallbacks('profiles', [q('id,nickname,vk_user_id', 'nickname.asc'), q('id,nickname', 'nickname.asc')]),
    fetchTableWithFallbacks('character_skills', [q('character_id,skill_id', 'character_id.asc')]),
    fetchTableWithFallbacks('skills', [
      q('id,category_id,name,description,summary,content_html,image_url,is_metamagic,required_race_id,required_subrace_id,required_profession_id,required_profession_level', 'name.asc'),
      q('id,category_id,name,description,image_url,is_metamagic', 'name.asc'),
      q('id,name', 'name.asc'),
    ]),
    fetchTableWithFallbacks('character_spells', [q('character_id,spell_id', 'character_id.asc')]),
    fetchTableWithFallbacks('spells', [
      q('id,branch_id,name,description,summary,content_html,image_url,required_race_id,required_subrace_id,required_profession_id,required_profession_level', 'name.asc'),
      q('id,branch_id,name,description,image_url', 'name.asc'),
      q('id,name', 'name.asc'),
    ]),
    fetchTableWithFallbacks('character_professions', [q('character_id,profession_id,level', 'character_id.asc')]).catch(() => []),
    fetchTableWithFallbacks('character_states', [q('id,character_id,state_id,note,applied_at', 'character_id.asc')]).catch(() => []),
    fetchTableWithFallbacks('state_definitions', [
      q('id,name,summary,content_html,image_url,is_active', 'name.asc'),
      q('id,name,content_html,image_url,is_active', 'name.asc'),
      q('id,name,summary,image_url,is_active', 'name.asc'),
      q('id,name,image_url,is_active', 'name.asc'),
      q('id,name', 'name.asc'),
    ]).catch(() => []),
  ]);

  const approvedCharacters = (characters ?? []).filter((row) => String(row.status ?? '') === 'approved');
  const profileById = new Map((profiles ?? []).map((row) => [row.id, row]));
  const skillById = new Map((skills ?? []).map((row) => [row.id, row]));
  const spellById = new Map((spells ?? []).map((row) => [row.id, row]));
  const stateDefinitionById = new Map((stateDefinitions ?? []).map((row) => [row.id, row]));

  const skillLinksByCharacterId = new Map();
  for (const row of characterSkills ?? []) {
    const current = skillLinksByCharacterId.get(row.character_id) ?? [];
    current.push(row.skill_id);
    skillLinksByCharacterId.set(row.character_id, current);
  }

  const spellLinksByCharacterId = new Map();
  for (const row of characterSpells ?? []) {
    const current = spellLinksByCharacterId.get(row.character_id) ?? [];
    current.push(row.spell_id);
    spellLinksByCharacterId.set(row.character_id, current);
  }

  const professionsByCharacterId = new Map();
  for (const row of characterProfessions ?? []) {
    const current = professionsByCharacterId.get(row.character_id) ?? [];
    current.push({ character_id: row.character_id, profession_id: row.profession_id, level: row.level ?? 1 });
    professionsByCharacterId.set(row.character_id, current);
  }

  const statesByCharacterId = new Map();
  for (const row of characterStates ?? []) {
    const current = statesByCharacterId.get(row.character_id) ?? [];
    current.push({
      id: row.id ?? 0,
      character_id: row.character_id,
      state_id: row.state_id,
      note: row.note ?? null,
      applied_at: row.applied_at ?? null,
      state: stateDefinitionById.get(row.state_id) ?? null,
    });
    statesByCharacterId.set(row.character_id, current);
  }

  const rpcRowIds = new Set((rows ?? []).map((row) => row.id));
  const sourceRows = rpcRowIds.size > 0
    ? approvedCharacters.filter((row) => rpcRowIds.has(row.id))
    : approvedCharacters;

  const cards = sourceRows.map((row) => ({
    id: row.id,
    owner_id: row.owner_id,
    owner_nickname: profileById.get(row.owner_id)?.nickname ?? null,
    owner_vk_user_id: profileById.get(row.owner_id)?.vk_user_id ?? null,
    source: 'approved_snapshot',
    character: { ...row },
    skills: (skillLinksByCharacterId.get(row.id) ?? []).map((skillId) => skillById.get(skillId)).filter(Boolean),
    spells: (spellLinksByCharacterId.get(row.id) ?? []).map((spellId) => spellById.get(spellId)).filter(Boolean),
    professions: professionsByCharacterId.get(row.id) ?? [],
    states: statesByCharacterId.get(row.id) ?? [],
  }));

  cards.sort((a, b) => String(a.character?.full_name ?? '').localeCompare(String(b.character?.full_name ?? ''), 'ru'));

  return {
    generated_at: new Date().toISOString(),
    cards,
  };
}


async function buildMapsPublicBundle() {
  const [maps, mapMarkers, mapRegions] = await Promise.all([
    fetchTableWithFallbacks('maps', ['select=*']).catch(() => []),
    fetchTableWithFallbacks('map_markers', ['select=*']).catch(() => []),
    fetchTableWithFallbacks('map_regions', ['select=*']).catch(() => []),
  ]);

  return {
    generated_at: new Date().toISOString(),
    maps,
    map_markers: mapMarkers,
    map_regions: mapRegions,
  };
}

async function buildShopCatalogBundle() {
  const [shopItems, items, factions, thresholds, effectDefinitions] = await Promise.all([
    fetchTableWithFallbacks('shop_items', ['select=*']).catch(() => []),
    fetchTableWithFallbacks('items', ['select=*']).catch(() => []),
    fetchTableWithFallbacks('factions', ['select=*']).catch(() => []),
    fetchTableWithFallbacks('reputation_thresholds', ['select=*']).catch(() => []),
    fetchTableWithFallbacks('state_definitions', ['select=*']).catch(() => []),
  ]);

  return {
    generated_at: new Date().toISOString(),
    shop_items: shopItems,
    items,
    factions,
    thresholds,
    effect_definitions: effectDefinitions,
  };
}

async function buildCraftCatalogBundle() {
  const [recipes, recipeIngredients, items] = await Promise.all([
    fetchTableWithFallbacks('recipes', ['select=*']).catch(() => []),
    fetchTableWithFallbacks('recipe_ingredients', ['select=*']).catch(() => []),
    fetchTableWithFallbacks('items', ['select=*']).catch(() => []),
  ]);

  return {
    generated_at: new Date().toISOString(),
    recipes,
    recipe_ingredients: recipeIngredients,
    items,
  };
}

function buildManifest({ reference, content, characterCards, mapsPublic, shopCatalog, craftCatalog, worldPublic }) {
  const generatedAt = new Date().toISOString();
  return {
    generated_at: generatedAt,
    bucket: 'github-pages',
    bundles: {
      reference: {
        path: 'bundles/reference.json',
        public_url: `${BUNDLE_PUBLIC_BASE_URL}/bundles/reference.json`,
        generated_at: reference.generated_at,
      },
      content: {
        path: 'bundles/content.json',
        public_url: `${BUNDLE_PUBLIC_BASE_URL}/bundles/content.json`,
        generated_at: content.generated_at,
      },
      'character-cards': {
        path: 'bundles/character-cards.json',
        public_url: `${BUNDLE_PUBLIC_BASE_URL}/bundles/character-cards.json`,
        generated_at: characterCards.generated_at,
      },
      'maps-public': {
        path: 'bundles/maps-public.json',
        public_url: `${BUNDLE_PUBLIC_BASE_URL}/bundles/maps-public.json`,
        generated_at: mapsPublic.generated_at,
      },
      'shop-catalog': {
        path: 'bundles/shop-catalog.json',
        public_url: `${BUNDLE_PUBLIC_BASE_URL}/bundles/shop-catalog.json`,
        generated_at: shopCatalog.generated_at,
      },
      'craft-catalog': {
        path: 'bundles/craft-catalog.json',
        public_url: `${BUNDLE_PUBLIC_BASE_URL}/bundles/craft-catalog.json`,
        generated_at: craftCatalog.generated_at,
      },
      'world-public': {
        path: 'bundles/world-public.json',
        public_url: `${BUNDLE_PUBLIC_BASE_URL}/bundles/world-public.json`,
        generated_at: worldPublic.generated_at,
      },
    },
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function writeSupportPages() {
  const indexHtml = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>RPG Bundles Mirror</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px auto; max-width: 860px; padding: 0 16px; line-height: 1.5; }
      code { background: #f3f5f8; padding: 2px 6px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <h1>RPG Bundles Mirror</h1>
    <p>Этот сайт раздаёт публичные JSON-бандлы для приложения.</p>
    <ul>
      <li><a href="./bundles/reference.json">reference.json</a></li>
      <li><a href="./bundles/content.json">content.json</a></li>
      <li><a href="./bundles/character-cards.json">character-cards.json</a></li>
      <li><a href="./bundles/maps-public.json">maps-public.json</a></li>
      <li><a href="./bundles/shop-catalog.json">shop-catalog.json</a></li>
      <li><a href="./bundles/craft-catalog.json">craft-catalog.json</a></li>
      <li><a href="./bundles/world-public.json">world-public.json</a></li>
      <li><a href="./bundles/manifest.json">manifest.json</a></li>
    </ul>
  </body>
</html>`;

  const notFoundHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head><body><h1>404</h1></body></html>`;
  await writeFile(path.join(OUTPUT_DIR, 'index.html'), indexHtml, 'utf8');
  await writeFile(path.join(OUTPUT_DIR, '404.html'), notFoundHtml, 'utf8');
}

async function main() {
  await mkdir(BUNDLES_DIR, { recursive: true });

  const [reference, content, characterCards, mapsPublic, shopCatalog, craftCatalog, worldPublic] = await Promise.all([
    buildReferenceBundle(),
    buildContentBundle(),
    buildCharacterCardsBundle(),
    buildMapsPublicBundle(),
    buildShopCatalogBundle(),
    buildCraftCatalogBundle(),
    buildWorldPublicBundle(),
  ]);

  const manifest = buildManifest({ reference, content, characterCards, mapsPublic, shopCatalog, craftCatalog, worldPublic });

  await Promise.all([
    writeJson(path.join(BUNDLES_DIR, 'reference.json'), reference),
    writeJson(path.join(BUNDLES_DIR, 'content.json'), content),
    writeJson(path.join(BUNDLES_DIR, 'character-cards.json'), characterCards),
    writeJson(path.join(BUNDLES_DIR, 'maps-public.json'), mapsPublic),
    writeJson(path.join(BUNDLES_DIR, 'shop-catalog.json'), shopCatalog),
    writeJson(path.join(BUNDLES_DIR, 'craft-catalog.json'), craftCatalog),
    writeJson(path.join(BUNDLES_DIR, 'world-public.json'), worldPublic),
    writeJson(path.join(BUNDLES_DIR, 'manifest.json'), manifest),
    writeSupportPages(),
  ]);

  console.log('Bundles generated successfully');
  console.log(`Public base URL: ${BUNDLE_PUBLIC_BASE_URL}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

