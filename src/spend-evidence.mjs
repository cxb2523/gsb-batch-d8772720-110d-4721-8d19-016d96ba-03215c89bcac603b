import { normalize } from './worlds.mjs';
import { uidText } from './hero-equipment.mjs';

const integer = value => Number.isSafeInteger(value) && value >= 0;
const read = async (client, name) => {
  const value = normalize(await client.request(name + 'Request', {}, name + 'Response'));
  // These optional wire fields have protobuf false/zero defaults. normalize()
  // drops prototype defaults, but an omitted field is not a missing message.
  if (name === 'CargoShips' && Array.isArray(value.ship)) value.ship = value.ship.map(ship => ({ ...ship, index: ship.index ?? 0,
    orderItem: ship.orderItem?.map(slot => ({ ...slot, filled: slot.filled ?? false })) }));
  if (name === 'OnWater') {
    if (Array.isArray(value.workerOrder)) value.workerOrder = value.workerOrder.map(order => ({ ...order, index: order.index ?? 0 }));
    if (value.orderOfTheDay) value.orderOfTheDay = { ...value.orderOfTheDay, orderNum: value.orderOfTheDay.orderNum ?? 0 };
  }
  return value;
};
const unique = (rows, key) => Array.isArray(rows) && rows.every(row => row && key(row) != null)
  && new Set(rows.map(key)).size === rows.length;
const buildingList = water => unique(water?.building, row => typeof row.buildingId === 'string' && row.buildingId ? row.buildingId : null) ? water.building : null;
const orderSignature = order => order && JSON.stringify([order.workerId ?? 0, order.textId ?? 0,
  order.refreshTime ?? 0, order.isSpecial ?? false, order.requirements]);
const jobKey = job => JSON.stringify([job.idx, job.petId, job.startTime]);
const factoryQueue = building => {
  const jobs = building?.factory?.factoryQ;
  if (!Array.isArray(jobs) || !jobs.every(row => typeof row?.productId === 'string' && row.productId)) return null;
  // The server omits finishTime for queued slots that are not the currently
  // active job. Those rows are still valid evidence when they carry a stable
  // idx. An unkeyed row without finishTime remains invalid because it cannot
  // be distinguished from the pre-action queue.
  const keyed = jobs.filter(row => Number.isSafeInteger(row.idx) && row.idx >= 0);
  if (!unique(keyed, row => row.idx)) return null;
  if (jobs.some(row => row.finishTime == null && !(Number.isSafeInteger(row.idx) && row.idx >= 0))) return null;
  if (jobs.some(row => row.finishTime != null && (!integer(row.finishTime) || row.finishTime <= 0))) return null;
  return jobs;
};
const cargoAsset = asset => typeof asset?.id === 'string' && asset.id && integer(asset.num) && asset.num > 0;
export const petSpendSnapshot = buildings => {
  const rooms = buildings.filter(row => row.petBreed);
  if (!rooms.length || rooms.some(row => !Array.isArray(row.petBreed.breedQ) || !Array.isArray(row.petBreed.maturePets))) return null;
  const jobs = rooms.flatMap(row => row.petBreed.breedQ), mature = rooms.flatMap(row => row.petBreed.maturePets);
  if (!unique(jobs, row => integer(row.idx) ? row.idx : null)
    || jobs.some(row => typeof row.petId !== 'string' || !row.petId || !integer(row.startTime)
      || !integer(row.finishTime) || row.finishTime < row.startTime)
    || mature.some(row => typeof row?.petId !== 'string' || !row.petId)) return null;
  return { jobs, mature };
};

export function confirmPetSpend(before, after, request, body) {
  if (!before || !after) return false;
  if (request === 'PetFeedRequest') {
    const prior = before.jobs.find(row => row.idx === body.jobIdx), job = after.jobs.find(row => row.idx === body.jobIdx);
    return !!prior && prior.petId === job?.petId && prior.startTime === job.startTime && job.finishTime < prior.finishTime;
  }
  return request === 'PetBreedRequest' && (after.jobs.some(job => job.petId === body.petId
    && !before.jobs.some(prior => jobKey(prior) === jobKey(job)))
    || after.mature.filter(pet => pet.petId === body.petId).length
      > before.mature.filter(pet => pet.petId === body.petId).length + before.jobs.filter(job => job.petId === body.petId).length);
}

// Keep immutable pre-action evidence, never a connection or settings closure.
// A replacement connection can therefore finish the same read-only check.
export async function captureSpendOperation(client, step, { waterSnapshot } = {}) {
  const body = structuredClone(step.body ?? {}), verify = structuredClone(step.verify ?? {});
  const request = step.request;
  const operation = { confirmed: false };
  const probe = test => { operation.verify = test; return operation; };

  if (request === 'PetUpgradeFeedRequest' && verify.petUid && integer(verify.fed) && integer(verify.grade)) {
    return probe(async next => {
      const raw = await next.request('AllPetRequest', {}, 'AllPetResponse');
      const pets = raw?.pets?.map(pet => ({ ...normalize(pet), uid: uidText(pet.uid) }));
      if (!unique(pets, pet => pet.uid)) return false;
      const pet = pets.find(row => String(row.uid) === verify.petUid);
      if (!pet || !integer(pet.grade ?? 0) || !Array.isArray(pet.profFeed)) return false;
      let fed = 0;
      for (const prof of pet.profFeed) {
        if (!Array.isArray(prof.attrFeed) || prof.attrFeed.some(attr => !integer(attr.times))) return false;
        fed += prof.attrFeed.reduce((sum, attr) => sum + attr.times, 0);
      }
      return fed > verify.fed || (pet.grade ?? 0) > verify.grade;
    });
  }
  if (['MuseumSpeedUpExploreRequest', 'MuseumUpgradeExhibitionRequest', 'MuseumUpgradeKeywordRequest'].includes(request)) {
    return probe(async next => {
      const museum = await read(next, 'MuseumInfo');
      if (request === 'MuseumSpeedUpExploreRequest') {
        if (!unique(museum.exploreStages, row => row.stageId)) return false;
        const end = museum.exploreStages.find(row => row.stageId === body.stageId)?.expedition?.endTime;
        return integer(end) && end > 0 && integer(verify.endTime) && end < verify.endTime;
      }
      if (!unique(museum.exhibitions, row => row.exhibitionId)) return false;
      const exhibition = museum.exhibitions.find(row => row.exhibitionId === body.exhibitionId);
      const level = request === 'MuseumUpgradeExhibitionRequest' ? exhibition?.level : exhibition?.keywordLevels?.[verify.index];
      return integer(level) && integer(verify.level) && level >= verify.level;
    });
  }
  if (['HeroLevelUpRequest', 'HeroStarUpRequest', 'HeroSkillLevelUpRequest'].includes(request)) {
    const target = request === 'HeroLevelUpRequest' ? step.targetLevel : step.to;
    if (!integer(target)) return operation;
    const levelOf = heroes => {
      if (!unique(heroes, row => row.heroId)) return null;
      const hero = heroes.find(row => row.heroId === body.heroId);
      return request === 'HeroLevelUpRequest' ? hero?.level : request === 'HeroStarUpRequest' ? hero?.star : hero?.skillLevels?.[body.skillIdx - 1];
    };
    const prior = levelOf((await read(client, 'AllHero')).heroes);
    if (!integer(prior) || prior >= target) return operation;
    return probe(async next => {
      const actual = levelOf((await read(next, 'AllHero')).heroes);
      return integer(actual) && actual >= target;
    });
  }
  if (['FillCargoShipRequest', 'SpeedUpShipRequest'].includes(request)) {
    const before = (await read(client, 'CargoShips')).ship;
    if (!unique(before, row => row.index)) return operation;
    const index = body.shipIndex ?? body.index, ship = before.find(row => row.index === index);
    if (!ship) return operation;
    return probe(async next => {
      const ships = (await read(next, 'CargoShips')).ship;
      if (!unique(ships, row => row.index)) return false;
      const after = ships.find(row => row.index === index);
      if (!after) return false;
      if (request === 'SpeedUpShipRequest') return integer(ship.arriveTime) && integer(after.arriveTime) && after.arriveTime > 0 && after.arriveTime < ship.arriveTime;
      return Array.isArray(body.cargoIndex) && body.cargoIndex.length > 0 && body.cargoIndex.every(index => {
        const old = ship.orderItem?.[index - 1], current = after.orderItem?.[index - 1];
        return old?.filled === false && current?.filled === true && cargoAsset(old.asset) && cargoAsset(current.asset)
          && old.asset.id === current.asset.id && old.asset.num === current.asset.num;
      });
    });
  }
  const waterRequests = new Set(['FinishWorkerOrderRequest', 'BuildBuildingRequest', 'UpgradeBuildingRequest',
    'StartFactoryProduceRequest', 'SpeedUpUpgradeBuildingRequest', 'SpeedUpFactoryProduceRequest', 'FarmSpeedUpRequest',
    'PetBreedRequest', 'PetFeedRequest', 'FishingLevelUpRequest', 'DivingLevelUpRequest', 'SalvageLevelUpRequest']);
  if (!waterRequests.has(request)) return operation;
  const before = waterSnapshot ? structuredClone(waterSnapshot) : await read(client, 'OnWater'), buildings = buildingList(before);
  if (!buildings) return operation;
  const old = buildings.find(row => row.buildingId === body.buildingId);
  if (request === 'UpgradeBuildingRequest' && (!old || !integer(old.level))) return operation;
  if (request === 'BuildBuildingRequest' && old && !integer(old.level)) return operation;
  const oldPets = ['PetBreedRequest', 'PetFeedRequest'].includes(request) ? petSpendSnapshot(buildings) : null;
  if (['PetBreedRequest', 'PetFeedRequest'].includes(request) && !oldPets) return operation;
  const day = Math.floor((Date.now() + (client.serverClockOffsetMs || 0) + 28800000) / 86400000);
  return probe(async next => {
    const after = await read(next, 'OnWater'), currentBuildings = buildingList(after);
    if (!currentBuildings) return false;
    const current = currentBuildings.find(row => row.buildingId === body.buildingId);
    if (request === 'FinishWorkerOrderRequest') {
      if (!unique(before.workerOrder, row => row.index) || !unique(after.workerOrder, row => row.index)) return false;
      const prior = before.workerOrder.find(row => row.index === body.index), order = after.workerOrder.find(row => row.index === body.index);
      const count = before.orderOfTheDay?.orderNum, nextCount = after.orderOfTheDay?.orderNum;
      return Array.isArray(prior?.requirements) && prior.requirements.length > 0 && prior.requirements.every(cargoAsset)
        && orderSignature(prior) !== orderSignature(order) && integer(count) && integer(nextCount) && nextCount > count
        && day === Math.floor((Date.now() + (next.serverClockOffsetMs || 0) + 28800000) / 86400000);
    }
    if (request === 'BuildBuildingRequest' || request === 'UpgradeBuildingRequest') {
      if (!current || !integer(current.level)) return false;
      return current.level > (old?.level ?? 0) || (integer(current.buildStartTime) && integer(current.buildFinishTime)
        && current.buildStartTime > (old?.buildStartTime ?? 0) && current.buildFinishTime > current.buildStartTime);
    }
    if (request === 'StartFactoryProduceRequest') {
      const beforeQ = factoryQueue(old), nextQ = factoryQueue(current);
      return !!beforeQ && !!nextQ && nextQ.some(job => job.productId === body.productId
        && integer(job.finishTime) && job.finishTime > 0
        && !beforeQ.some(prior => {
          if (prior.idx != null && job.idx != null && prior.idx === job.idx) {
            if (prior.productId !== job.productId) return false;
            // A stable queue slot can be present without finishTime until the
            // server starts it. Filling that field is the business evidence
            // for the just-sent production request.
            return integer(prior.finishTime) ? prior.finishTime >= job.finishTime : false;
          }
          // An unkeyed pre-existing row cannot be replaced by another unkeyed
          // row and still prove a new production request.
          return prior.idx == null && job.idx == null && prior.productId === job.productId;
        }));
    }
    if (request === 'SpeedUpUpgradeBuildingRequest') return integer(old?.buildFinishTime) && integer(current?.buildFinishTime)
      && current.buildFinishTime > 0 && current.buildFinishTime < old.buildFinishTime && current.level === old.level;
    if (request === 'SpeedUpFactoryProduceRequest') {
      const job = factoryQueue(old)?.find(row => (row.idx ?? 0) === body.index), changed = factoryQueue(current)?.find(row => (row.idx ?? 0) === body.index);
      return !!job && job.productId === changed?.productId && changed.finishTime < job.finishTime;
    }
    if (request === 'FarmSpeedUpRequest') return !!old?.farm?.productId && current?.farm?.productId === old.farm.productId
      && current.farm.plantTime === old.farm.plantTime && integer(current.farm.ripeTime) && current.farm.ripeTime < old.farm.ripeTime;
    if (request === 'PetBreedRequest' || request === 'PetFeedRequest') {
      return confirmPetSpend(oldPets, petSpendSnapshot(currentBuildings), request, body);
    }
    const field = { FishingLevelUpRequest: 'fishingLevel', DivingLevelUpRequest: 'divingLevel', SalvageLevelUpRequest: 'salvageLevel' }[request];
    return !!field && integer(before[field]?.level) && integer(after[field]?.level) && (after[field].level > before[field].level
      || (after[field].level === before[field].level && integer(after[field].enhance) && after[field].enhance > (before[field].enhance ?? 0)));
  });
}
