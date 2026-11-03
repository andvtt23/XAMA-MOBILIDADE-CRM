import { automaticCommission } from "./whatsappImport.js";

function getRideDate(ride) {
  return ride.date ?? ride.data ?? "";
}

function getRideDriverId(ride) {
  return ride.driverId ?? ride.motoristaId;
}

function getAmountCents(ride) {
  return Number(
    ride.amountCents
    ?? ride.valorCentavos
    ?? Math.round(Number(ride.amount ?? ride.valor ?? 0) * 100),
  );
}

function getWeekStart(dateValue) {
  const date = new Date(`${dateValue}T00:00:00Z`);
  const weekday = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + (weekday === 0 ? -6 : 1 - weekday));
  return date.toISOString().slice(0, 10);
}

export function calculateDriverPeriodTotals(rides, driver, start, end) {
  const allDriverRidesByWeek = new Map();
  for (const ride of rides) {
    const date = getRideDate(ride);
    if (
      ride.excludedFromTotals === true
      || String(getRideDriverId(ride)) !== String(driver.id)
      || !date
    ) continue;
    const weekStart = getWeekStart(date);
    allDriverRidesByWeek.set(
      weekStart,
      (allDriverRidesByWeek.get(weekStart) ?? 0) + 1,
    );
  }

  const selectedRides = rides.filter(ride => {
    const date = getRideDate(ride);
    return ride.excludedFromTotals !== true
      && String(getRideDriverId(ride)) === String(driver.id)
      && date >= start
      && date <= end;
  });
  const weeks = new Map();
  for (const ride of selectedRides) {
    const weekStart = getWeekStart(getRideDate(ride));
    weeks.set(weekStart, [...(weeks.get(weekStart) ?? []), ride]);
  }

  let revenueCents = 0;
  let commissionCents = 0;
  const rates = new Set();
  for (const weeklyRides of weeks.values()) {
    const rate = automaticCommission(
      driver,
      allDriverRidesByWeek.get(getWeekStart(getRideDate(weeklyRides[0]))) ?? 0,
    );
    const weeklyRevenueCents = weeklyRides.reduce(
      (sum, ride) => sum + getAmountCents(ride),
      0,
    );
    revenueCents += weeklyRevenueCents;
    commissionCents += Math.round(weeklyRevenueCents * rate / 100);
    rates.add(rate);
  }

  const rate = rates.size === 1
    ? rates.values().next().value
    : rates.size > 1
      ? null
      : automaticCommission(driver, 0);

  return {
    count: selectedRides.length,
    revenueCents,
    commissionCents,
    netCents: revenueCents - commissionCents,
    rate,
  };
}
