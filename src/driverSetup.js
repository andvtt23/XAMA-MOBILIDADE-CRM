export const INITIAL_DRIVER_NAMES = [
  "Letícia",
  "Camila",
  "Pamela",
  "Ana Paula",
  "Roberta",
  "Lyzandra",
  "Dalvana",
  "Janaína",
  "Luciana",
  "Mariane",
  "Isabela",
  "Laura",
  "Gabryelle",
  "Luiz Gabriel",
  "Juninho",
  "Denilson",
  "Diógenes",
  "Luiz Aparecido (Pacheco)",
  "Lucas",
  "Macaus",
  "Yuri",
  "Vicente",
  "Pablo",
  "Diogo",
  "Max",
  "Felipe",
  "Vantuir",
  "Jean",
  "Emerson",
  "Gustavo",
  "Gabriel",
  "Eleandro",
  "Heder",
  "Matheus",
  "Thiago Candal",
  "Alexandre",
  "José Raimundo",
  "Saulo",
  "Ricardo",
  "Matheus Cassiano",
  "Alex",
  "Décio",
  "Augusto",
  "Guilherme",
  "Cauê",
  "Bryan",
  "Fabio filho",
  "Rafael",
  "Abraão",
  "Clesio",
  "Luíz",
  "Miguel",
  "Valter",
  "Michel",
  "Manuelito",
  "Haxel",
  "Fabio pai",
  "Diego",
  "Jhonatan",
  "Marcelo",
  "Alessandro",
];

export const INITIAL_FEMALE_DRIVER_NAMES = [
  "Letícia",
  "Camila",
  "Pamela",
  "Ana Paula",
  "Roberta",
  "Lyzandra",
  "Dalvana",
  "Janaína",
  "Luciana",
  "Mariane",
  "Isabela",
  "Laura",
  "Gabryelle",
];

export function normalizeDriverName(name) {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("pt-BR");
}

export function sortDriversAlphabetically(drivers) {
  return [...drivers].sort((left, right) => (
    String(left.nome ?? "").localeCompare(String(right.nome ?? ""), "pt-BR", {
      sensitivity: "base",
    })
  ));
}

export function mergeInitialDrivers(savedDrivers) {
  const drivers = Array.isArray(savedDrivers) ? [...savedDrivers] : [];
  const existingNames = new Set(drivers.map(driver => normalizeDriverName(driver.nome)));
  const usedIds = new Set(drivers.map(driver => String(driver.id)));

  for (const name of INITIAL_DRIVER_NAMES) {
    const normalizedName = normalizeDriverName(name);
    if (existingNames.has(normalizedName)) continue;

    const idBase = `initial-${normalizedName.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    let id = idBase;
    let suffix = 2;
    while (usedIds.has(id)) {
      id = `${idBase}-${suffix}`;
      suffix += 1;
    }

    const isFemale = INITIAL_FEMALE_DRIVER_NAMES.some(
      femaleName => normalizeDriverName(femaleName) === normalizedName,
    );
    const hasSpecialCommission = normalizedName === "lyzandra"
      || normalizedName === "abraao";

    drivers.push({
      id,
      nome: name,
      comissao: hasSpecialCommission ? 10 : 15,
      comissaoEspecial: hasSpecialCommission,
      generoRegra: isFemale ? "mulher" : "outro",
    });
    existingNames.add(normalizedName);
    usedIds.add(id);
  }

  return sortDriversAlphabetically(drivers);
}
