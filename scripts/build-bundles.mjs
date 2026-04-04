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

async function fetchTable(table, query, options = {}) {
  const maxAttempts = Number(options.maxAttempts ?? 4);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(buildRestUrl(table, query), { headers });
      if (!res.ok) {
        const text = await res.text();
        const error = new Error(`REST ${table} failed: ${res.status} ${text}`);
        const retriable = res.status === 429 || res.status >= 500;
        if (!retriable || attempt === maxAttempts) {
          throw error;
        }
        lastError = error;
      } else {
        return await res.json();
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === maxAttempts) {
        throw lastError;
      }
    }

    const delayMs = 600 * attempt;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw lastError ?? new Error(`REST ${table} failed`);
}

async function fetchTableWithFallbacks(table, queries) {
  const errors = [];
  for (const query of queries) {
    try {
      return await fetchTable(table, query);
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

function normalizeEmbeddedItemRows(rows) {
  return rows.map((row) => ({
    ...row,
    item: Array.isArray(row.item) ? (row.item[0] ?? null) : (row.item ?? null),
  }));
}

function uniqById(rows) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const id = row?.id;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(row);
  }
  return result;
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
    state_definitions: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(stateDefinitions), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
  };
}

async function buildContentBundle() {
  const [contentPages, libraryEntries, npcEntries, bestiaryEntries] = await Promise.all([
    fetchTableWithFallbacks('content_pages', [
      q('id,slug,title,content,summary,content_html,image_url,external_url,sort_order,is_published,updated_at', 'sort_order.asc.nullslast,id.asc'),
      q('id,slug,title,content,summary,image_url,external_url,sort_order,is_published,updated_at', 'sort_order.asc.nullslast,id.asc'),
      q('id,slug,title,content,summary,image_url,external_url,is_published,updated_at', 'id.asc'),
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
    content_pages: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(contentPages), ['content', 'summary', 'content_html', 'image_url', 'external_url', 'is_published', 'updated_at']), 'title'),
    library_entries: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(libraryEntries), ['entry_type', 'summary', 'content', 'content_html', 'image_url', 'external_url', 'is_published']), 'title'),
    npc_entries: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(npcEntries), ['npc_type', 'faction_id', 'summary', 'description', 'content', 'content_html', 'image_url', 'external_url', 'is_published'])),
    bestiary_entries: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(bestiaryEntries), ['creature_type', 'danger_level', 'summary', 'description', 'content', 'content_html', 'image_url', 'external_url', 'is_published'])),
  };
}

async function buildCharacterCardsBundle() {
  const [characters, profiles, characterSkills, skills, characterSpells, spells, characterProfessions, characterStates, stateDefinitions] = await Promise.all([
    fetchTableWithFallbacks('characters', [
      q('id,owner_id,full_name,gender,birth_day,birth_month,birth_year,race_id,subrace_id,faction_id,character_role_id,profession_id,image_url,appearance,appearance_html,biography,biography_html,personality,personality_html,weaknesses,weaknesses_html,status,moderation_note,created_at,updated_at', 'updated_at.desc.nullslast'),
      q('id,owner_id,full_name,gender,birth_day,birth_month,birth_year,race_id,subrace_id,faction_id,character_role_id,profession_id,image_url,appearance,biography,personality,weaknesses,status,moderation_note,created_at,updated_at', 'updated_at.desc.nullslast'),
      q('id,owner_id,full_name,status,updated_at', 'updated_at.desc.nullslast'),
    ]),
    fetchTableWithFallbacks('profiles', [q('id,nickname', 'nickname.asc')]),
    fetchTableWithFallbacks('character_skills', [q('character_id,skill_id', 'character_id.asc')]).catch(() => []),
    fetchTableWithFallbacks('skills', [
      q('id,category_id,name,description,summary,content_html,image_url,is_metamagic,required_race_id,required_subrace_id,required_profession_id,required_profession_level', 'name.asc'),
      q('id,category_id,name,description,image_url,is_metamagic', 'name.asc'),
      q('id,name', 'name.asc'),
    ]).catch(() => []),
    fetchTableWithFallbacks('character_spells', [q('character_id,spell_id', 'character_id.asc')]).catch(() => []),
    fetchTableWithFallbacks('spells', [
      q('id,branch_id,name,description,summary,content_html,image_url,required_race_id,required_subrace_id,required_profession_id,required_profession_level', 'name.asc'),
      q('id,branch_id,name,description,image_url', 'name.asc'),
      q('id,name', 'name.asc'),
    ]).catch(() => []),
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

  const cards = approvedCharacters.map((row) => ({
    id: row.id,
    owner_id: row.owner_id,
    owner_nickname: profileById.get(row.owner_id)?.nickname ?? null,
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
  const [maps, locations] = await Promise.all([
    fetchTableWithFallbacks('maps', [
      q('id,title,slug,description,external_url,sort_order,is_active', 'sort_order.asc.nullslast,id.asc'),
      q('id,title,slug,description,external_url,is_active', 'id.asc'),
      q('id,title,slug,is_active', 'id.asc'),
    ]),
    fetchTableWithFallbacks('locations', [
      q('id,map_id,name,x,y,discussion_url,flag_sprite,description,image_url,marker_type,marker_color,layer_group,is_active', 'id.asc'),
      q('id,map_id,name,x,y,discussion_url,flag_sprite,description,image_url,is_active', 'id.asc'),
      q('id,map_id,name,x,y,description,is_active', 'id.asc'),
    ]),
  ]);

  return {
    generated_at: new Date().toISOString(),
    maps: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(maps), ['description', 'external_url', 'is_active']), 'title'),
    locations: normalizeOptionalKeys(uniqById(locations), ['discussion_url', 'flag_sprite', 'description', 'image_url', 'marker_type', 'marker_color', 'layer_group', 'is_active'])
      .sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0)),
  };
}

async function buildShopCatalogBundle() {
  const [shopItems, items, thresholds, effectDefinitions, factions] = await Promise.all([
    fetchTableWithFallbacks('shop_items', [
      q('id,item_id,buy_price,is_active,stock_quantity,item:items(id,name,category,rarity,category_id,rarity_id,image_url,description,buy_price,sell_price,can_gift,can_delete,is_equippable,equip_slot_type,weapon_handedness,item_use_type,teaches_skill_id,teaches_spell_id)', 'id.asc'),
      q('id,item_id,buy_price,is_active,stock_quantity', 'id.asc'),
    ]),
    fetchTableWithFallbacks('items', [
      q('id,name,category,rarity,category_id,rarity_id,image_url,description,buy_price,sell_price,can_gift,can_delete,is_equippable,equip_slot_type,weapon_handedness,item_use_type,teaches_skill_id,teaches_spell_id', 'name.asc'),
      q('id,name,category,rarity,image_url,description,buy_price,sell_price', 'name.asc'),
      q('id,name', 'name.asc'),
    ]),
    fetchTableWithFallbacks('reputation_thresholds', [
      q('id,faction_id,target_type,target_id,required_value,note', 'id.asc'),
    ]),
    fetchTableWithFallbacks('effect_definitions', [
      q('id,name,category,description,image_url,craft_success_bonus,metamagic_power_bonus,shop_discount_percent', 'name.asc'),
      q('id,name,category,image_url,craft_success_bonus,metamagic_power_bonus,shop_discount_percent', 'name.asc'),
    ]),
    fetchTableWithFallbacks('factions', [
      q('id,name', 'name.asc'),
    ]),
  ]);

  return {
    generated_at: new Date().toISOString(),
    shop_items: normalizeEmbeddedItemRows(shopItems).filter((row) => row.is_active !== false),
    items: normalizeOptionalKeys(items, ['category', 'rarity', 'image_url', 'description', 'buy_price', 'sell_price']),
    thresholds: (thresholds ?? []).filter((row) => row.target_type === 'shop_item'),
    effect_definitions: normalizeOptionalKeys(effectDefinitions, ['description', 'image_url', 'craft_success_bonus', 'metamagic_power_bonus', 'shop_discount_percent']),
    factions,
  };
}

async function buildCraftCatalogBundle() {
  const [
    items,
    skills,
    professions,
    recipes,
    recipeIngredients,
    recipeSkillRequirements,
    recipeSpellRequirements,
    spells,
    metamagicOptions,
    thresholds,
    effectDefinitions,
  ] = await Promise.all([
    fetchTableWithFallbacks('items', [
      q('id,name,category,rarity,category_id,rarity_id,image_url,description,buy_price,sell_price,can_gift,can_delete,is_equippable,equip_slot_type,weapon_handedness,item_use_type,teaches_skill_id,teaches_spell_id,is_attachment,mod_slot_count,is_consumed_on_use', 'name.asc'),
      q('id,name,category,rarity,category_id,rarity_id,image_url,description,buy_price,sell_price,can_gift,can_delete,is_equippable,equip_slot_type,weapon_handedness,item_use_type,teaches_skill_id,teaches_spell_id', 'name.asc'),
    ]),
    fetchTableWithFallbacks('skills', [
      q('id,name,description,category_id,image_url,is_metamagic', 'name.asc'),
      q('id,name,category_id,image_url,is_metamagic', 'name.asc'),
    ]),
    fetchTableWithFallbacks('professions', [
      q('id,name,description,image_url', 'name.asc'),
      q('id,name,image_url', 'name.asc'),
    ]),
    fetchTableWithFallbacks('recipes', [
      q('id,name,description,recipe_type,success_chance,required_profession_id,required_profession_level,base_item_id,base_item_quantity,result_item_id,result_quantity', 'name.asc'),
      q('id,name,description,recipe_type,success_chance,required_profession_id,required_profession_level,base_item_id,base_item_quantity', 'name.asc'),
      q('id,name,recipe_type,success_chance,required_profession_id,required_profession_level,base_item_id,base_item_quantity', 'name.asc'),
    ]),
    fetchTableWithFallbacks('recipe_ingredients', [
      q('id,recipe_id,item_id,quantity', 'id.asc'),
    ]),
    fetchTableWithFallbacks('recipe_skill_requirements', [
      q('id,recipe_id,skill_id', 'id.asc'),
    ]),
    fetchTableWithFallbacks('recipe_spell_requirements', [
      q('id,recipe_id,spell_id', 'id.asc'),
    ]),
    fetchTableWithFallbacks('spells', [
      q('id,name,description,branch_id,image_url', 'name.asc'),
      q('id,name,branch_id,image_url', 'name.asc'),
    ]),
    fetchTableWithFallbacks('metamagic_options', [
      q('id,name,description,required_skill_id', 'name.asc'),
      q('id,name,required_skill_id', 'name.asc'),
    ]),
    fetchTableWithFallbacks('reputation_thresholds', [
      q('id,faction_id,target_type,target_id,required_value,note', 'id.asc'),
    ]),
    fetchTableWithFallbacks('effect_definitions', [
      q('id,name,category,description,image_url,craft_success_bonus,metamagic_power_bonus,shop_discount_percent', 'name.asc'),
      q('id,name,category,image_url,craft_success_bonus,metamagic_power_bonus,shop_discount_percent', 'name.asc'),
    ]),
  ]);

  return {
    generated_at: new Date().toISOString(),
    items: normalizeOptionalKeys(items, ['description', 'image_url', 'is_attachment', 'mod_slot_count', 'is_consumed_on_use']),
    skills: normalizeOptionalKeys(skills, ['description', 'image_url', 'is_metamagic']),
    professions: normalizeOptionalKeys(professions, ['description', 'image_url']),
    recipes: normalizeOptionalKeys(recipes, ['description', 'result_item_id', 'result_quantity']),
    recipe_ingredients: recipeIngredients,
    recipe_skill_requirements: recipeSkillRequirements,
    recipe_spell_requirements: recipeSpellRequirements,
    spells: normalizeOptionalKeys(spells, ['description', 'image_url']),
    metamagic_options: normalizeOptionalKeys(metamagicOptions, ['description']),
    thresholds: (thresholds ?? []).filter((row) => row.target_type === 'recipe'),
    effect_definitions: normalizeOptionalKeys(effectDefinitions, ['description', 'image_url', 'craft_success_bonus', 'metamagic_power_bonus', 'shop_discount_percent']),
  };
}

function buildManifest(bundles) {
  const generatedAt = new Date().toISOString();
  const manifestBundles = {};
  for (const [key, value] of Object.entries(bundles)) {
    manifestBundles[key] = {
      path: `bundles/${key}.json`,
      public_url: `${BUNDLE_PUBLIC_BASE_URL}/bundles/${key}.json`,
      generated_at: value.generated_at,
    };
  }

  return {
    generated_at: generatedAt,
    bucket: 'github-pages',
    bundles: manifestBundles,
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function writeSupportPages(bundleNames) {
  const links = bundleNames.map((name) => `      <li><a href="bundles/${name}.json">${name}.json</a></li>`).join('\n');
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
${links}
      <li><a href="bundles/manifest.json">manifest.json</a></li>
    </ul>
  </body>
</html>`;

  await writeFile(path.join(OUTPUT_DIR, 'index.html'), indexHtml, 'utf8');
}

async function main() {
  await mkdir(BUNDLES_DIR, { recursive: true });

  const reference = await buildReferenceBundle();
  const content = await buildContentBundle();
  const characterCards = await buildCharacterCardsBundle();
  const mapsPublic = await buildMapsPublicBundle();
  const shopCatalog = await buildShopCatalogBundle();
  const craftCatalog = await buildCraftCatalogBundle();

  const bundles = {
    reference,
    content,
    'character-cards': characterCards,
    'maps-public': mapsPublic,
    'shop-catalog': shopCatalog,
    'craft-catalog': craftCatalog,
  };

  for (const [name, value] of Object.entries(bundles)) {
    await writeJson(path.join(BUNDLES_DIR, `${name}.json`), value);
  }

  const manifest = buildManifest(bundles);
  await writeJson(path.join(BUNDLES_DIR, 'manifest.json'), manifest);
  await writeSupportPages(Object.keys(bundles));
}

await main();
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

async function fetchTable(table, query, options = {}) {
  const maxAttempts = Number(options.maxAttempts ?? 4);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(buildRestUrl(table, query), { headers });
      if (!res.ok) {
        const text = await res.text();
        const error = new Error(`REST ${table} failed: ${res.status} ${text}`);
        const retriable = res.status === 429 || res.status >= 500;
        if (!retriable || attempt === maxAttempts) {
          throw error;
        }
        lastError = error;
      } else {
        return await res.json();
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === maxAttempts) {
        throw lastError;
      }
    }

    const delayMs = 600 * attempt;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw lastError ?? new Error(`REST ${table} failed`);
}

async function fetchTableWithFallbacks(table, queries) {
  const errors = [];
  for (const query of queries) {
    try {
      return await fetchTable(table, query);
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

function normalizeEmbeddedItemRows(rows) {
  return rows.map((row) => ({
    ...row,
    item: Array.isArray(row.item) ? (row.item[0] ?? null) : (row.item ?? null),
  }));
}

function uniqById(rows) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const id = row?.id;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(row);
  }
  return result;
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
    state_definitions: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(stateDefinitions), ['description', 'summary', 'content_html', 'image_url', 'is_active'])),
  };
}

async function buildContentBundle() {
  const [contentPages, libraryEntries, npcEntries, bestiaryEntries] = await Promise.all([
    fetchTableWithFallbacks('content_pages', [
      q('id,slug,title,content,summary,content_html,image_url,external_url,sort_order,is_published,updated_at', 'sort_order.asc.nullslast,id.asc'),
      q('id,slug,title,content,summary,image_url,external_url,sort_order,is_published,updated_at', 'sort_order.asc.nullslast,id.asc'),
      q('id,slug,title,content,summary,image_url,external_url,is_published,updated_at', 'id.asc'),
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
    content_pages: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(contentPages), ['content', 'summary', 'content_html', 'image_url', 'external_url', 'is_published', 'updated_at']), 'title'),
    library_entries: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(libraryEntries), ['entry_type', 'summary', 'content', 'content_html', 'image_url', 'external_url', 'is_published']), 'title'),
    npc_entries: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(npcEntries), ['npc_type', 'faction_id', 'summary', 'description', 'content', 'content_html', 'image_url', 'external_url', 'is_published'])),
    bestiary_entries: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(bestiaryEntries), ['creature_type', 'danger_level', 'summary', 'description', 'content', 'content_html', 'image_url', 'external_url', 'is_published'])),
  };
}

async function buildCharacterCardsBundle() {
  const [characters, profiles, characterSkills, skills, characterSpells, spells, characterProfessions, characterStates, stateDefinitions] = await Promise.all([
    fetchTableWithFallbacks('characters', [
      q('id,owner_id,full_name,gender,birth_day,birth_month,birth_year,race_id,subrace_id,faction_id,character_role_id,profession_id,image_url,appearance,appearance_html,biography,biography_html,personality,personality_html,weaknesses,weaknesses_html,status,moderation_note,created_at,updated_at', 'updated_at.desc.nullslast'),
      q('id,owner_id,full_name,gender,birth_day,birth_month,birth_year,race_id,subrace_id,faction_id,character_role_id,profession_id,image_url,appearance,biography,personality,weaknesses,status,moderation_note,created_at,updated_at', 'updated_at.desc.nullslast'),
      q('id,owner_id,full_name,status,updated_at', 'updated_at.desc.nullslast'),
    ]),
    fetchTableWithFallbacks('profiles', [q('id,nickname', 'nickname.asc')]),
    fetchTableWithFallbacks('character_skills', [q('character_id,skill_id', 'character_id.asc')]).catch(() => []),
    fetchTableWithFallbacks('skills', [
      q('id,category_id,name,description,summary,content_html,image_url,is_metamagic,required_race_id,required_subrace_id,required_profession_id,required_profession_level', 'name.asc'),
      q('id,category_id,name,description,image_url,is_metamagic', 'name.asc'),
      q('id,name', 'name.asc'),
    ]).catch(() => []),
    fetchTableWithFallbacks('character_spells', [q('character_id,spell_id', 'character_id.asc')]).catch(() => []),
    fetchTableWithFallbacks('spells', [
      q('id,branch_id,name,description,summary,content_html,image_url,required_race_id,required_subrace_id,required_profession_id,required_profession_level', 'name.asc'),
      q('id,branch_id,name,description,image_url', 'name.asc'),
      q('id,name', 'name.asc'),
    ]).catch(() => []),
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

  const cards = approvedCharacters.map((row) => ({
    id: row.id,
    owner_id: row.owner_id,
    owner_nickname: profileById.get(row.owner_id)?.nickname ?? null,
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
  const [maps, locations] = await Promise.all([
    fetchTableWithFallbacks('maps', [
      q('id,title,slug,description,external_url,sort_order,is_active', 'sort_order.asc.nullslast,id.asc'),
      q('id,title,slug,description,external_url,is_active', 'id.asc'),
      q('id,title,slug,is_active', 'id.asc'),
    ]),
    fetchTableWithFallbacks('locations', [
      q('id,map_id,name,x,y,discussion_url,flag_sprite,description,image_url,marker_type,marker_color,layer_group,is_active', 'id.asc'),
      q('id,map_id,name,x,y,discussion_url,flag_sprite,description,image_url,is_active', 'id.asc'),
      q('id,map_id,name,x,y,description,is_active', 'id.asc'),
    ]),
  ]);

  return {
    generated_at: new Date().toISOString(),
    maps: sortBySortOrderThen(normalizeOptionalKeys(withDefaultSortOrder(maps), ['description', 'external_url', 'is_active']), 'title'),
    locations: normalizeOptionalKeys(uniqById(locations), ['discussion_url', 'flag_sprite', 'description', 'image_url', 'marker_type', 'marker_color', 'layer_group', 'is_active'])
      .sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0)),
  };
}

async function buildShopCatalogBundle() {
  const [shopItems, items, thresholds, effectDefinitions, factions] = await Promise.all([
    fetchTableWithFallbacks('shop_items', [
      q('id,item_id,buy_price,is_active,stock_quantity,item:items(id,name,category,rarity,category_id,rarity_id,image_url,description,buy_price,sell_price,can_gift,can_delete,is_equippable,equip_slot_type,weapon_handedness,item_use_type,teaches_skill_id,teaches_spell_id)', 'id.asc'),
      q('id,item_id,buy_price,is_active,stock_quantity', 'id.asc'),
    ]),
    fetchTableWithFallbacks('items', [
      q('id,name,category,rarity,category_id,rarity_id,image_url,description,buy_price,sell_price,can_gift,can_delete,is_equippable,equip_slot_type,weapon_handedness,item_use_type,teaches_skill_id,teaches_spell_id', 'name.asc'),
      q('id,name,category,rarity,image_url,description,buy_price,sell_price', 'name.asc'),
      q('id,name', 'name.asc'),
    ]),
    fetchTableWithFallbacks('reputation_thresholds', [
      q('id,faction_id,target_type,target_id,required_value,note', 'id.asc'),
    ]),
    fetchTableWithFallbacks('effect_definitions', [
      q('id,name,category,description,image_url,craft_success_bonus,metamagic_power_bonus,shop_discount_percent', 'name.asc'),
      q('id,name,category,image_url,craft_success_bonus,metamagic_power_bonus,shop_discount_percent', 'name.asc'),
    ]),
    fetchTableWithFallbacks('factions', [
      q('id,name', 'name.asc'),
    ]),
  ]);

  return {
    generated_at: new Date().toISOString(),
    shop_items: normalizeEmbeddedItemRows(shopItems).filter((row) => row.is_active !== false),
    items: normalizeOptionalKeys(items, ['category', 'rarity', 'image_url', 'description', 'buy_price', 'sell_price']),
    thresholds: (thresholds ?? []).filter((row) => row.target_type === 'shop_item'),
    effect_definitions: normalizeOptionalKeys(effectDefinitions, ['description', 'image_url', 'craft_success_bonus', 'metamagic_power_bonus', 'shop_discount_percent']),
    factions,
  };
}

async function buildCraftCatalogBundle() {
  const [
    items,
    skills,
    professions,
    recipes,
    recipeIngredients,
    recipeSkillRequirements,
    recipeSpellRequirements,
    spells,
    metamagicOptions,
    thresholds,
    effectDefinitions,
  ] = await Promise.all([
    fetchTableWithFallbacks('items', [
      q('id,name,category,rarity,category_id,rarity_id,image_url,description,buy_price,sell_price,can_gift,can_delete,is_equippable,equip_slot_type,weapon_handedness,item_use_type,teaches_skill_id,teaches_spell_id,is_attachment,mod_slot_count,is_consumed_on_use', 'name.asc'),
      q('id,name,category,rarity,category_id,rarity_id,image_url,description,buy_price,sell_price,can_gift,can_delete,is_equippable,equip_slot_type,weapon_handedness,item_use_type,teaches_skill_id,teaches_spell_id', 'name.asc'),
    ]),
    fetchTableWithFallbacks('skills', [
      q('id,name,description,category_id,image_url,is_metamagic', 'name.asc'),
      q('id,name,category_id,image_url,is_metamagic', 'name.asc'),
    ]),
    fetchTableWithFallbacks('professions', [
      q('id,name,description,image_url', 'name.asc'),
      q('id,name,image_url', 'name.asc'),
    ]),
    fetchTableWithFallbacks('recipes', [
      q('id,name,description,recipe_type,success_chance,required_profession_id,required_profession_level,base_item_id,base_item_quantity,result_item_id,result_quantity', 'name.asc'),
      q('id,name,description,recipe_type,success_chance,required_profession_id,required_profession_level,base_item_id,base_item_quantity', 'name.asc'),
      q('id,name,recipe_type,success_chance,required_profession_id,required_profession_level,base_item_id,base_item_quantity', 'name.asc'),
    ]),
    fetchTableWithFallbacks('recipe_ingredients', [
      q('id,recipe_id,item_id,quantity', 'id.asc'),
    ]),
    fetchTableWithFallbacks('recipe_skill_requirements', [
      q('id,recipe_id,skill_id', 'id.asc'),
    ]),
    fetchTableWithFallbacks('recipe_spell_requirements', [
      q('id,recipe_id,spell_id', 'id.asc'),
    ]),
    fetchTableWithFallbacks('spells', [
      q('id,name,description,branch_id,image_url', 'name.asc'),
      q('id,name,branch_id,image_url', 'name.asc'),
    ]),
    fetchTableWithFallbacks('metamagic_options', [
      q('id,name,description,required_skill_id', 'name.asc'),
      q('id,name,required_skill_id', 'name.asc'),
    ]),
    fetchTableWithFallbacks('reputation_thresholds', [
      q('id,faction_id,target_type,target_id,required_value,note', 'id.asc'),
    ]),
    fetchTableWithFallbacks('effect_definitions', [
      q('id,name,category,description,image_url,craft_success_bonus,metamagic_power_bonus,shop_discount_percent', 'name.asc'),
      q('id,name,category,image_url,craft_success_bonus,metamagic_power_bonus,shop_discount_percent', 'name.asc'),
    ]),
  ]);

  return {
    generated_at: new Date().toISOString(),
    items: normalizeOptionalKeys(items, ['description', 'image_url', 'is_attachment', 'mod_slot_count', 'is_consumed_on_use']),
    skills: normalizeOptionalKeys(skills, ['description', 'image_url', 'is_metamagic']),
    professions: normalizeOptionalKeys(professions, ['description', 'image_url']),
    recipes: normalizeOptionalKeys(recipes, ['description', 'result_item_id', 'result_quantity']),
    recipe_ingredients: recipeIngredients,
    recipe_skill_requirements: recipeSkillRequirements,
    recipe_spell_requirements: recipeSpellRequirements,
    spells: normalizeOptionalKeys(spells, ['description', 'image_url']),
    metamagic_options: normalizeOptionalKeys(metamagicOptions, ['description']),
    thresholds: (thresholds ?? []).filter((row) => row.target_type === 'recipe'),
    effect_definitions: normalizeOptionalKeys(effectDefinitions, ['description', 'image_url', 'craft_success_bonus', 'metamagic_power_bonus', 'shop_discount_percent']),
  };
}

function buildManifest(bundles) {
  const generatedAt = new Date().toISOString();
  const manifestBundles = {};
  for (const [key, value] of Object.entries(bundles)) {
    manifestBundles[key] = {
      path: `bundles/${key}.json`,
      public_url: `${BUNDLE_PUBLIC_BASE_URL}/bundles/${key}.json`,
      generated_at: value.generated_at,
    };
  }

  return {
    generated_at: generatedAt,
    bucket: 'github-pages',
    bundles: manifestBundles,
  };
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function writeSupportPages(bundleNames) {
  const links = bundleNames.map((name) => `      <li><a href="bundles/${name}.json">${name}.json</a></li>`).join('\n');
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
${links}
      <li><a href="bundles/manifest.json">manifest.json</a></li>
    </ul>
  </body>
</html>`;

  await writeFile(path.join(OUTPUT_DIR, 'index.html'), indexHtml, 'utf8');
}

async function main() {
  await mkdir(BUNDLES_DIR, { recursive: true });

  const reference = await buildReferenceBundle();
  const content = await buildContentBundle();
  const characterCards = await buildCharacterCardsBundle();
  const mapsPublic = await buildMapsPublicBundle();
  const shopCatalog = await buildShopCatalogBundle();
  const craftCatalog = await buildCraftCatalogBundle();

  const bundles = {
    reference,
    content,
    'character-cards': characterCards,
    'maps-public': mapsPublic,
    'shop-catalog': shopCatalog,
    'craft-catalog': craftCatalog,
  };

  for (const [name, value] of Object.entries(bundles)) {
    await writeJson(path.join(BUNDLES_DIR, `${name}.json`), value);
  }

  const manifest = buildManifest(bundles);
  await writeJson(path.join(BUNDLES_DIR, 'manifest.json'), manifest);
  await writeSupportPages(Object.keys(bundles));
}

await main();
