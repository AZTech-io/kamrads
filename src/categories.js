// Sectors: what kind of thing a lot is, for the sidebar, filters and alert rules.
// Order matters - the first sector whose words match wins. "general" is the catch-all
// (paint, household, clothing...) and is hidden by default.
import { isVehicle } from './extract.js';

export const SECTORS = [
  { key: 'cars', label: 'Cars & utes', group: 'Vehicles' },
  { key: 'vans', label: 'Vans & buses', group: 'Vehicles' },
  { key: 'trucks', label: 'Trucks & prime movers', group: 'Vehicles' },
  { key: 'trailers', label: 'Trailers', group: 'Vehicles' },
  { key: 'bikes', label: 'Motorbikes', group: 'Vehicles' },
  { key: 'marine', label: 'Boats & caravans', group: 'Vehicles' },
  { key: 'warehouse', label: 'Forklifts & warehouse', group: 'Freight & plant' },
  { key: 'plant', label: 'Plant & machinery', group: 'Freight & plant' },
  { key: 'tools', label: 'Tools & electrical', group: 'Freight & plant' },
  { key: 'vending', label: 'Vending & retail', group: 'Business equipment' },
  { key: 'hospitality', label: 'Hospitality & laundry', group: 'Business equipment' },
  { key: 'it', label: 'IT & office', group: 'Business equipment' },
  { key: 'general', label: 'General goods', group: 'Other' },
];

const RULES = [
  ['bikes', /motor ?(bike|cycle)s?|\bscooters?\b|harley|kawasaki|ducati|\bktm\b|\bdirt ?bike|quad ?bike|\batv\b|yamaha (?:yz|wr|mt|r1|r6|xt|tt)/],
  ['trailers', /\btrailers?\b|\bdolly\b|low ?loader|flat ?top|\bb-?double\b|tautliner|skel(?:etal)?\b|car ?carrier|tipping trailer|box trailer|plant trailer/],
  ['trucks', /\btrucks?\b|prime mover|tipper|isuzu [nfg][pqr]r|\bhino\b|fuso|kenworth|scania|\bmack\b|freightliner|western star|\bdaf\b|volvo f[hm]|\biveco\b|tray ?back|cab chassis|pantech|curtain ?sider|refrigerated body|tilt ?tray|water cart|street sweeper|garbage|compactor body/],
  ['vans', /\bvans?\b|\bbus(es)?\b|hiace|sprinter|renault master|\biload\b|\bstaria\b|transit|crafter|trafic|\bvito\b|kombi|coaster|\brosa\b|\bkangoo\b|\bcaddy\b|\bexpress van\b|people mover/],
  ['marine', /\bboats?\b|marine|jet ?ski|outboard|caravans?|camper|motorhome|pop ?top|\btinny\b|pontoon|\byacht\b|kayak/],
  ['warehouse', /forklifts?|fork lift|pallet (?:jack|truck|racking|wrapper)|reach truck|order picker|stacker|racking|shelving|mezzanine|shipping container|stretch wrap|loading dock|conveyor|scissor lift|elevated work|\bewp\b|boom lift|telehandler|warehouse/],
  ['plant', /excavat|backhoe|loader|bobcat|skid ?steer|dozer|grader|roller|tractor|harvester|slasher|mower|generator|compressor|light tower|crane|concrete|\bpump\b|machinery|\bplant\b|attachment|\bbucket\b|auger|hammer drill rig|earthmoving|irrigation/],
  ['vending', /vending|coin mech|bill validator|snack machine|drinks? machine|display (?:fridge|freezer)|bar fridge|\bpos\b|point of sale|cash register|eftpos|shop ?fit|retail display|\bkiosk\b|coffee machine|slushie|ice machine/],
  ['hospitality', /washer|washing machine|dryer|laundry|linen|towels?|\bironer\b|commercial kitchen|combi oven|fryer|dishwasher|glasswasher|cool ?room|freezer|refrigerat|\bhotel\b|hospitality|catering|bed(?:ding|s)?\b|mattress|massage|spa\b|salon|beauty/],
  ['it', /laptops?|notebook|desktop|computer|\bpc\b|server|monitor|printer|\bipad|tablet|iphone|phone|samsung galaxy|network|switch|router|projector|\btv\b|television|office (?:chair|desk|furniture)|desk|filing cabinet|cctv|camera/],
  ['tools', /\btools?\b|makita|milwaukee|dewalt|ryobi|bosch|hilti|festool|welder|welding|grinder|drill|saw|lathe|press|workshop|test ?(?:and|&) ?tag|electrical|cable|switchboard|ladder|scaffold|air ?con|extinguisher|fire (?:hose|blanket|equipment)|\bppe\b|safety/],
];

const VEHICLE_RULES = RULES.slice(0, 5);
const GOODS_RULES = RULES.slice(5);

/** Which sector a lot belongs to. */
export function sectorOf(lot) {
  // (Grays files every car under "motor-vehicles-motor-cycles": that's not a motorbike)
  const t = `${lot.title || ''} ${lot.category || ''} ${lot.sale_name || ''} ${lot.url || ''}`.toLowerCase().replace(/[-_/]/g, ' ')
    .replace(/motor vehicles motor ?cycles/g, 'motor vehicles');
  if (isVehicle(lot)) return (VEHICLE_RULES.find(([, re]) => re.test(t)) || ['cars'])[0];
  // Equipment words first, so a "pallet truck" is warehouse gear, not a truck.
  const goods = GOODS_RULES.find(([, re]) => re.test(t));
  if (goods) return goods[0];
  const veh = VEHICLE_RULES.find(([, re]) => re.test(t)); // e.g. "8x5 box trailer", "tinny with outboard"
  return veh ? veh[0] : 'general';
}

export const isCore = lot => sectorOf(lot) !== 'general';
