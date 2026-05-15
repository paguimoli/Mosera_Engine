"use client";

import { useEffect, useState } from "react";

const states = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "IL", name: "Illinois" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "MA", name: "Massachusetts" },
  { code: "MD", name: "Maryland" },
  { code: "MI", name: "Michigan" },
  { code: "NJ", name: "New Jersey" },
  { code: "NY", name: "New York" },
  { code: "OH", name: "Ohio" },
  { code: "PA", name: "Pennsylvania" },
  { code: "TX", name: "Texas" },
  { code: "VA", name: "Virginia" },
  { code: "WA", name: "Washington" },
];
function getExposureByNumbers(drawing: any) {
  const exposure: Record<string, number> = {};

  (drawing.bets || []).forEach((bet: any) => {
    const combo = bet.numbers.trim();

    if (!exposure[combo]) {
      exposure[combo] = 0;
    }

    exposure[combo] += Number(bet.potentialPayout || 0);
  });

  return Object.entries(exposure)
    .map(([numbers, payout]) => ({ numbers, payout }))
    .sort((a, b) => b.payout - a.payout);
}
const DEFAULT_TIME_ZONE = "America/New_York";


export default function Home() {
  const [games, setGames] = useState<any[]>([]);
  const [drawings, setDrawings] = useState<any[]>([]);
  const [currentTime, setCurrentTime] = useState(new Date());
  const [expandedGameIds, setExpandedGameIds] = useState<number[]>([]);
  const [expandedDrawingIds, setExpandedDrawingIds] = useState<string[]>([]);  
  const [editingGameIndex, setEditingGameIndex] = useState<number | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [showCreateGame, setShowCreateGame] = useState(true);
  const [showCreateDrawing, setShowCreateDrawing] = useState(true);
  const [showPrintableReport, setShowPrintableReport] = useState(false);
  const [reportFilters, setReportFilters] = useState({
  fromDate: "",
  toDate: "",
  state: "",
  game: "",
  status: "",
});
  const [mockBetForm, setMockBetForm] = useState({
  drawingId: "",
  numbers: "",
  amount: "",
  betType: "straight"
});

  const [form, setForm] = useState({
  state: "",
  name: "",
  status: "Active",
  gameType: "pick_n",
  mainNumbersCount: "",
  mainNumbersMin: "",
  mainNumbersMax: "",
  bonusNumbersCount: "",
  bonusNumbersMin: "",
  bonusNumbersMax: "",
  ticketPrice: "",
  scheduleType: "one_time",
  recurringFrequency: "daily",
  defaultDrawTime: "",
  defaultCutoffTime: "",
  defaultTimeZone: "America/New_York",
  payoutMultiplier: "",
  maxPayout: "",
  defaultMaxBet: "",
  defaultMaxTotalHandle: "",
  defaultMaxTotalLiability: "",
  
});
const [selectedGameIndex, setSelectedGameIndex] = useState("");

  const [drawingForm, setDrawingForm] = useState({
    gameIndex: "",
    drawDate: "",
    drawTime: "",
    cutoffTime: "",
    timeZone: "America/New_York",
    status: "scheduled",
    maxBet: "",
    maxTotalHandle: "",
    maxTotalLiability: "",
  });
  useEffect(() => {
  const savedGames = localStorage.getItem("lotteryGames");
  const savedDrawings = localStorage.getItem("lotteryDrawings");

  if (savedGames) {
    setGames(JSON.parse(savedGames));
  }

  if (savedDrawings) {
    setDrawings(JSON.parse(savedDrawings));
  }
}, []);
useEffect(() => {
  localStorage.setItem("lotteryGames", JSON.stringify(games));
}, [games]);

useEffect(() => {
  localStorage.setItem("lotteryDrawings", JSON.stringify(drawings));
}, [drawings]);

  function handleChange(
    event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) {
    setForm({ ...form, [event.target.name]: event.target.value });
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (editingGameIndex !== null) {
  setGames(
    games.map((game: any, index: number) =>
      index === editingGameIndex ? form : game
    )
    
  );

  setEditingGameIndex(null);
} else {
  setGames([...games, form]);
}

    setForm({
  state: "",
  name: "",
  status: "Active",
  gameType: "pick_n",
  mainNumbersCount: "",
  mainNumbersMin: "",
  mainNumbersMax: "",
  bonusNumbersCount: "",
  bonusNumbersMin: "",
  bonusNumbersMax: "",
  ticketPrice: "",
  scheduleType: "one_time",
  recurringFrequency: "daily",
  defaultDrawTime: "",
  defaultCutoffTime: "",
  defaultTimeZone: "America/New_York",
  payoutMultiplier: "",
  maxPayout: "",
  defaultMaxBet: "",
  defaultMaxTotalHandle: "",
  defaultMaxTotalLiability: "",
});
  }

  function handleDrawingChange(
  event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
) {
  const { name, value } = event.target;

  if (name === "gameIndex") {
    const selectedGame = games[Number(value)];

    if (!selectedGame) return;

    setDrawingForm({
      ...drawingForm,
      gameIndex: value,
      drawTime: selectedGame.defaultDrawTime || "",
      cutoffTime: selectedGame.defaultCutoffTime || "",
      timeZone: selectedGame.defaultTimeZone || "America/New_York",
    });

    return;
  }

  setDrawingForm({
    ...drawingForm,
    [name]: value,
  });
  }
function handleReportFilterChange(
  e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
) {
  const { name, value } = e.target;

  setReportFilters((prev) => ({
    ...prev,
    [name]: value,
  }));
}
  function handleDrawingSubmit(event: React.FormEvent) {
  event.preventDefault();

  const selectedGame = games[Number(drawingForm.gameIndex)];

  const now = new Date();
  const cutoffDateTime = new Date(
    `${drawingForm.drawDate}T${drawingForm.cutoffTime}`
  );

  let calculatedStatus = drawingForm.status;

  if (now > cutoffDateTime) {
    calculatedStatus = "closed";
  }
const drawingId = `${selectedGame.state}-${selectedGame.name
  .replace(/\s+/g, "-")
  .toUpperCase()}-${drawingForm.drawDate}-${Date.now()}`;


  setDrawings([
  ...drawings,
  {
    id: drawingId,
    ...drawingForm,
    status: calculatedStatus,
    game: selectedGame,
    totalHandle: 0,
    totalPotentialPayout: 0,
    worstCaseLiability: 0,
    housePosition: 0,
    winningNumbers: "",
    winningBonus: "",
    resultSource: "",
    settledAt: "",
    bets: [],
  },

  ]);

    setDrawingForm({
      gameIndex: "",
      drawDate: "",
      drawTime: "",
      cutoffTime: "",
      timeZone: "America/New_York",
      status: "scheduled",
      maxBet: "",
      maxTotalHandle: "",
      maxTotalLiability: "",
    });
    
  }
  function getDrawingStatus(drawing: any) {
  const now = currentTime;

  // Get current time in the drawing's timezone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone:
  drawing.timeZone &&
  drawing.timeZone !== "DEFAULT_TIME_ZONE"
    ? drawing.timeZone
    : "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);

  const get = (type: string) =>
    parts.find((p) => p.type === type)?.value;

  const nowInTZ = new Date(
    `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`
  );

  const cutoffDateTime = new Date(
    `${drawing.drawDate}T${drawing.cutoffTime}`
  );

  if (nowInTZ > cutoffDateTime) {
    return "closed";
  }

  return drawing.status;
}
function generateTodayDrawings() {
  const today = new Date().toISOString().split("T")[0];

  const targetGames =
  selectedGameIndex === ""
    ? games
    : [games[Number(selectedGameIndex)]];

const newDrawings = targetGames
    .filter((game: any) => game.scheduleType === "recurring")
    .map((game: any) => {
      const drawingId = `${game.state}-${game.name
        .replace(/\s+/g, "-")
        .toUpperCase()}-${today}-${game.defaultDrawTime}`;

      const alreadyExists = drawings.some(
        (drawing: any) => drawing.id === drawingId
      );

      if (alreadyExists) {
        return null;
      }

      return {
        id: drawingId,
        game,
        drawDate: today,
        drawTime: game.defaultDrawTime,
        cutoffTime: game.defaultCutoffTime,
        timeZone: game.defaultTimeZone || "America/New_York",
        status: "scheduled",
        maxBet: game.defaultMaxBet || "",
        maxTotalHandle: game.defaultMaxTotalHandle || "",
        maxTotalLiability: game.defaultMaxTotalLiability || "",
        totalHandle: 0,
        totalPotentialPayout: 0,
        worstCaseLiability: 0,
        housePosition: 0,
        winningNumbers: "",
        winningBonus: "",
        resultSource: "",
        settledAt: "",
        bets: [],
        
      };
    })
    .filter(Boolean);

  setDrawings([...drawings, ...newDrawings]);

alert(
  newDrawings.length > 0
    ? `${newDrawings.length} drawing(s) generated for today.`
    : "No new drawings generated. They may already exist or no recurring game was selected."
);
}
  
function generateNext7Days() {
  const newDrawings: any[] = [];

  const targetGames =
  selectedGameIndex === ""
    ? games
    : [games[Number(selectedGameIndex)]];

targetGames
    .filter((game: any) => game.scheduleType === "recurring")
    .forEach((game: any) => {
      for (let i = 0; i < 7; i++) {
        const date = new Date();
        date.setDate(date.getDate() + i);

        const drawDate = date.toISOString().split("T")[0];

        const drawingId = `${game.state}-${game.name
          .replace(/\s+/g, "-")
          .toUpperCase()}-${drawDate}-${game.defaultDrawTime}`;

        const alreadyExists = drawings.some(
          (drawing: any) => drawing.id === drawingId
        );

        if (!alreadyExists) {
          newDrawings.push({
            id: drawingId,
            game,
            drawDate,
            drawTime: game.defaultDrawTime,
            cutoffTime: game.defaultCutoffTime,
            timeZone: game.defaultTimeZone || "America/New_York",
            status: "scheduled",
            maxBet: game.defaultMaxBet || "",
            maxTotalHandle: game.defaultMaxTotalHandle || "",
            maxTotalLiability: game.defaultMaxTotalLiability || "",
            totalHandle: 0,
            totalPotentialPayout: 0,
            worstCaseLiability: 0,
            housePosition: 0,
            winningNumbers: "",
            winningBonus: "",
            resultSource: "",
            settledAt: "",
            bets: [],
            
          });
        }
      }
    });

  setDrawings([...drawings, ...newDrawings]);

alert(
  newDrawings.length > 0
    ? `${newDrawings.length} drawing(s) generated for the next 7 days.`
    : "No new drawings generated. They may already exist or no recurring game was selected."
);
}


function handleMockBetChange(
  event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
) {
  setMockBetForm({
    ...mockBetForm,
    [event.target.name]: event.target.value,
  });
}
function factorial(n: number): number {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

function getBoxWayCount(numbers: string) {
  const digits = numbers.replace(/[^0-9]/g, "").split("");

  const counts: Record<string, number> = {};

  digits.forEach((digit) => {
    counts[digit] = (counts[digit] || 0) + 1;
  });

  const totalDigits = digits.length;

  const duplicateFactor = Object.values(counts).reduce(
    (total, count) => total * factorial(count),
    1
  );

  return factorial(totalDigits) / duplicateFactor;
}

function getAdjustedMultiplier(
  baseMultiplier: number,
  betType: string,
  numbers: string
) {
  if (betType === "straight") {
    return baseMultiplier;
  }

  if (betType === "box") {
    const ways = getBoxWayCount(numbers);

    if (ways <= 1) {
      return baseMultiplier;
    }

    return baseMultiplier / ways;
  }

  return baseMultiplier;
}
function handleMockBetSubmit(event: React.FormEvent) {
  event.preventDefault();

  setDrawings(drawings.map((drawing: any) => {
      if (drawing.id !== mockBetForm.drawingId) {
        return drawing;
      }
      if (drawing.status === "settled") {
  alert("Bet rejected. This drawing has already been settled.");
  return drawing;
}
if (getDrawingStatus(drawing) === "closed") {
  alert("Bet rejected. This drawing is closed.");
  return drawing;
}
      const numbersArray = mockBetForm.numbers
  .split("-")
  .map((n) => n.trim())
  .filter((n) => n !== "")
  .map((n) => Number(n));
  const minNumber = Number(drawing.game.mainNumbersMin);
const maxNumber = Number(drawing.game.mainNumbersMax);

const outOfRangeNumber = numbersArray.find(
  (number) => number < minNumber || number > maxNumber
);

if (outOfRangeNumber !== undefined) {
  alert(
    `Number ${outOfRangeNumber} is invalid. This game only allows numbers from ${minNumber} to ${maxNumber}.`
  );
  return drawing;
}

const requiredCount = Number(drawing.game.mainNumbersCount);

if (numbersArray.length !== requiredCount) {
  alert(`This game requires exactly ${requiredCount} numbers.`);
  return drawing;
}
      const betAmount = Number(mockBetForm.amount);
      const maxBet = Number(drawing.maxBet || 0);

if (maxBet > 0 && betAmount > maxBet) {
  alert(`Bet rejected. Max bet for this drawing is ${formatMoney(maxBet)}.`);
  return drawing;
}
      const multiplier = Number(drawing.game.payoutMultiplier || 0);
      const maxPayout = Number(drawing.game.maxPayout || 0);

      const adjustedMultiplier = getAdjustedMultiplier(
  multiplier,
  mockBetForm.betType,
  mockBetForm.numbers
);

const calculatedPayout = betAmount * adjustedMultiplier;

const potentialPayout =
  maxPayout > 0
    ? Math.min(calculatedPayout, maxPayout)
    : calculatedPayout;

      let newBets: any[] = [];

if (mockBetForm.betType === "straight_box") {
  // Straight leg
  const straightMultiplier = multiplier;
  const straightPayout =
    maxPayout > 0
      ? Math.min(betAmount * straightMultiplier, maxPayout)
      : betAmount * straightMultiplier;

  // Box leg
  const boxMultiplier = getAdjustedMultiplier(
    multiplier,
    "box",
    mockBetForm.numbers
  );

  const boxPayout =
    maxPayout > 0
      ? Math.min(betAmount * boxMultiplier, maxPayout)
      : betAmount * boxMultiplier;

  newBets = [
    {
      id: `BET-${Date.now()}-S`,
      drawingId: drawing.id,
      numbers: mockBetForm.numbers,
      betType: "straight",
      amount: betAmount,
      potentialPayout: straightPayout,
      placedAt: new Date().toISOString(),
      status: "accepted",
    },
    {
      id: `BET-${Date.now()}-B`,
      drawingId: drawing.id,
      numbers: mockBetForm.numbers,
      betType: "box",
      amount: betAmount,
      potentialPayout: boxPayout,
      placedAt: new Date().toISOString(),
      status: "accepted",
    },
  ];
} else {
  newBets = [
    {
      id: `BET-${Date.now()}`,
      drawingId: drawing.id,
      numbers: mockBetForm.numbers,
      betType: mockBetForm.betType,
      amount: betAmount,
      potentialPayout,
      placedAt: new Date().toISOString(),
      status: "accepted",
        },
  ];
}

      const updatedBets = [...(drawing.bets || []), ...newBets];
      

      const exposureMap: Record<string, number> = {};

      updatedBets.forEach((bet: any) => {
        const combo = bet.numbers.trim();
        exposureMap[combo] =
          (exposureMap[combo] || 0) + Number(bet.potentialPayout);
      });

      const worstCase = Math.max(...Object.values(exposureMap), 0);
      const maxLiability = Number(drawing.maxTotalLiability || 0);

if (maxLiability > 0 && worstCase > maxLiability) {
  alert(
    `Bet rejected. This would exceed max liability of ${formatMoney(maxLiability)}.`
  );
  return drawing;
}
      return {
        ...drawing,
        bets: updatedBets,
        totalHandle: Number(drawing.totalHandle || 0) + betAmount,
        totalPotentialPayout:
          Number(drawing.totalPotentialPayout || 0) + potentialPayout,
        worstCaseLiability: worstCase,
        housePosition:
          Number(drawing.totalHandle || 0) +
          betAmount -
          (Number(drawing.totalPotentialPayout || 0) + potentialPayout),
      };
    })
  );

  setMockBetForm({
    drawingId: "",
    numbers: "",
    amount: "",
    betType: "straight",
  });
}
  function toggleDrawingDetails(id: string) {
  setExpandedDrawingIds((prev) =>
    prev.includes(id)
      ? prev.filter((drawingId) => drawingId !== id)
      : [...prev, id]
  );


}
function formatMoney(value: any) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}
function toggleDrawingDetails(id: string) {
  setExpandedDrawingIds((prev) =>
    prev.includes(id)
      ? prev.filter((drawingId) => drawingId !== id)
      : [...prev, id]);
}
function toggleGameDetails(index: number) {
  setExpandedGameIds((prev) =>
    prev.includes(index)
      ? prev.filter((gameIndex) => gameIndex !== index)
      : [...prev, index]
  );
}
function disableGame(index: number) {
  const confirmed = confirm("Disable this game? Existing drawings and bets will remain.");

  if (!confirmed) return;

  setGames(
    games.map((game: any, gameIndex: number) =>
      gameIndex === index ? { ...game, status: "disabled" } : game
    )
  );
}

function archiveGame(index: number) {
  const confirmed = confirm("Archive this game? Historical drawings and bets will remain.");

  if (!confirmed) return;

  setGames(
    games.map((game: any, gameIndex: number) =>
      gameIndex === index ? { ...game, status: "archived" } : game
    )
  );
}

function deleteGame(index: number) {
  const gameToDelete = games[index];

  const relatedDrawings = drawings.filter(
    (drawing: any) =>
      drawing.game.name === gameToDelete.name &&
      drawing.game.state === gameToDelete.state
  );

  const hasBets = relatedDrawings.some(
    (drawing: any) => drawing.bets && drawing.bets.length > 0
  );

  if (hasBets) {
    alert("Delete blocked. This game has drawings with bets attached.");
    return;
  }

  const confirmed = confirm(
    relatedDrawings.length > 0
      ? "Delete this game and its drawings? This cannot be undone."
      : "Delete this game? This cannot be undone."
  );

  if (!confirmed) return;

  setGames(games.filter((_: any, gameIndex: number) => gameIndex !== index));

  setDrawings(
    drawings.filter(
      (drawing: any) =>
        !(
          drawing.game.name === gameToDelete.name &&
          drawing.game.state === gameToDelete.state
        )
    )
  );
}
function editGame(index: number) {
  setEditingGameIndex(index);
  setForm(games[index]);
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function updateDrawingResult(index: number, field: string, value: string) {
  setDrawings(
    drawings.map((drawing: any, drawingIndex: number) =>
      drawingIndex === index
        ? {
            ...drawing,
            [field]: value,
          }
        : drawing
    )
  );
  function normalizeNumbers(value: string) {
  return value
    .split("-")
    .map((n) => n.trim())
    .filter(Boolean)
    .join("-");
}

function sortNumbers(value: string) {
  return value
    .split("-")
    .map((n) => n.trim())
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b))
    .join("-");
}

function isWinningBet(bet: any, winningNumbers: string) {
  const betNumbers = normalizeNumbers(bet.numbers);
  const resultNumbers = normalizeNumbers(winningNumbers);

  if (bet.betType === "straight") {
    return betNumbers === resultNumbers;
  }

  if (bet.betType === "box") {
    return sortNumbers(betNumbers) === sortNumbers(resultNumbers);
  }

  return false;
}

}
function settleDrawing(index: number) {
  const drawing = drawings[index];
  if (drawing.status === "settled") {
  alert("This drawing has already been settled.");
  return;
}

  if (!drawing.winningNumbers) {
    alert("Enter winning numbers before settling.");
    return;
  }

  const confirmed = confirm("Settle this drawing? This will mark bets as winners or losers.");

  if (!confirmed) return;

  const winningNumbers = drawing.winningNumbers.trim();

  const settledBets = (drawing.bets || []).map((bet: any) => {
    const isWinner = isWinningBet(bet, winningNumbers);

    return {
      ...bet,
      status: isWinner ? "winner" : "loser",
      settledAt: new Date().toISOString(),
    };
  });

  const totalPayout = settledBets
    .filter((bet: any) => bet.status === "winner")
    .reduce((sum: number, bet: any) => sum + Number(bet.potentialPayout || 0), 0);

    const finalHousePosition =
  Number(drawing.totalHandle || 0) - totalPayout;

  setDrawings(
    drawings.map((item: any, drawingIndex: number) =>
      drawingIndex === index
        ? {
            ...item,
            bets: settledBets,
            status: "settled",
            settledAt: new Date().toISOString(),
            actualPayout: totalPayout,
            housePosition: finalHousePosition,
          }
        : item
    )
  );


alert(
  `Drawing settled. Total payout: ${formatMoney(totalPayout)}. House result: ${formatMoney(finalHousePosition)}.`
);
}
function normalizeNumbers(value: string) {
  return value
    .split("-")
    .map((n) => n.trim())
    .filter(Boolean)
    .join("-");
}

function sortNumbers(value: string) {
  return value
    .split("-")
    .map((n) => n.trim())
    .filter(Boolean)
    .sort((a, b) => Number(a) - Number(b))
    .join("-");
}

function isWinningBet(bet: any, winningNumbers: string) {
  const betNumbers = normalizeNumbers(bet.numbers);
  const resultNumbers = normalizeNumbers(winningNumbers);

  if (bet.betType === "straight") {
    return betNumbers === resultNumbers;
  }

  if (bet.betType === "box") {
    return sortNumbers(betNumbers) === sortNumbers(resultNumbers);
  }

  return false;
}

function reopenDrawing(index: number) {
  const drawing = drawings[index];

  if (drawing.status !== "settled") {
    alert("Only settled drawings can be reopened.");
    return;
  }

  if (!overrideReason.trim()) {
    alert("Enter an override reason before reopening.");
    return;
  }

  const confirmed = confirm(
    "Reopen this settled drawing? This will unlock results and reset bet settlement statuses."
  );

  if (!confirmed) return;

  setDrawings(
    drawings.map((item: any, drawingIndex: number) =>
      drawingIndex === index
        ? {
            ...item,
            status: "closed",
            settledAt: "",
            actualPayout: 0,
            housePosition: Number(item.totalHandle || 0),
            overrideReason,
            reopenedAt: new Date().toISOString(),
            bets: (item.bets || []).map((bet: any) => ({
              ...bet,
              status: "accepted",
              settledAt: "",
            })),
          }
        : item
    )
  );

  setOverrideReason("");

  alert("Drawing reopened. You can now correct results and settle again.");
}
function getDashboardMetrics() {
  const totalGames = games.length;
  const filteredDrawings = drawings.filter((drawing: any) => {
  const drawingDate = drawing.drawDate;

  if (
    reportFilters.fromDate &&
    drawingDate < reportFilters.fromDate
  ) {
    return false;
  }

  if (
    reportFilters.toDate &&
    drawingDate > reportFilters.toDate
  ) {
    return false;
  }

  if (
    reportFilters.state &&
    drawing.game.state !== reportFilters.state
  ) {
    return false;
  }

  if (
    reportFilters.game &&
    drawing.game.name !== reportFilters.game
  ) {
    return false;
  }

  if (
    reportFilters.status &&
    drawing.status !== reportFilters.status
  ) {
    return false;
  }

  return true;
});
  const totalDrawings = filteredDrawings.length;

  const openDrawings = filteredDrawings.filter(
    (drawing: any) => getDrawingStatus(drawing) === "open"
  ).length;

  const closedDrawings = filteredDrawings.filter(
    (drawing: any) => getDrawingStatus(drawing) === "closed"
  ).length;

  const settledDrawings = filteredDrawings.filter(
    (drawing: any) => drawing.status === "settled"
  ).length;

  const totalHandle = filteredDrawings.reduce(
    (sum: number, drawing: any) => sum + Number(drawing.totalHandle || 0),
    0
  );

  const totalPotentialPayout = filteredDrawings.reduce(
    (sum: number, drawing: any) =>
      sum + Number(drawing.totalPotentialPayout || 0),
    0
  );

  const actualPayout = filteredDrawings.reduce(
    (sum: number, drawing: any) => sum + Number(drawing.actualPayout || 0),
    0
  );

  const houseResult = totalHandle - actualPayout;

  return {
    totalGames,
    totalDrawings,
    openDrawings,
    closedDrawings,
    settledDrawings,
    totalHandle,
    totalPotentialPayout,
    actualPayout,
    houseResult,
  };
}
const metrics = getDashboardMetrics();
function printReport() {
  window.print();
}  
return (
  
    <main className="min-h-screen bg-gray-100 p-8 text-gray-900">
      <div className="mx-auto max-w-5xl">
        <h1 className="mb-2 text-3xl font-bold">Lottery Admin Dashboard</h1>
        <p className="mb-6 text-sm text-gray-600" suppressHydrationWarning>
  Default app time zone: Eastern Time (
  {new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(currentTime)}
  )
</p>
<section className="mt-6 rounded-xl bg-white p-4 shadow">
  <h2 className="mb-4 text-xl font-semibold">Reporting Filters</h2>

  <div className="grid gap-4 md:grid-cols-5">
    <label className="grid gap-1">
      <span className="text-sm font-medium">From Date</span>
      <input
        type="date"
        name="fromDate"
        value={reportFilters.fromDate}
        onChange={handleReportFilterChange}
        className="rounded border p-2 text-gray-900"
      />
    </label>

    <label className="grid gap-1">
      <span className="text-sm font-medium">To Date</span>
      <input
        type="date"
        name="toDate"
        value={reportFilters.toDate}
        onChange={handleReportFilterChange}
        className="rounded border p-2 text-gray-900"
      />
    </label>

    <label className="grid gap-1">
      <span className="text-sm font-medium">State</span>
      <select
        name="state"
        value={reportFilters.state}
        onChange={handleReportFilterChange}
        className="rounded border p-2 text-gray-900"
      >
        <option value="">All States</option>
        {states.map((state) => (
          <option key={state.code} value={state.code}>
            {state.name}
          </option>
        ))}
      </select>
    </label>

    <label className="grid gap-1">
      <span className="text-sm font-medium">Game</span>
      <select
        name="game"
        value={reportFilters.game}
        onChange={handleReportFilterChange}
        className="rounded border p-2 text-gray-900"
      >
        <option value="">All Games</option>
        {games.map((game: any, index: number) => (
          <option key={index} value={game.name}>
            {game.state} — {game.name}
          </option>
        ))}
      </select>
    </label>

    <label className="grid gap-1">
      <span className="text-sm font-medium">Status</span>
      <select
        name="status"
        value={reportFilters.status}
        onChange={handleReportFilterChange}
        className="rounded border p-2 text-gray-900"
      >
        <option value="">All Statuses</option>
        <option value="scheduled">Scheduled</option>
        <option value="open">Open</option>
        <option value="closed">Closed</option>
        <option value="settled">Settled</option>
      </select>
    </label>
  </div>
</section>
<section className="mt-6 grid gap-4 md:grid-cols-4">
  <div className="rounded-xl bg-white p-4 shadow">
    <p className="text-sm text-gray-500">Total Games</p>
    <p className="text-2xl font-bold">{metrics.totalGames}</p>
  </div>

  <div className="rounded-xl bg-white p-4 shadow">
    <p className="text-sm text-gray-500">Total Drawings</p>
    <p className="text-2xl font-bold">{metrics.totalDrawings}</p>
  </div>

  <div className="rounded-xl bg-white p-4 shadow">
    <p className="text-sm text-gray-500">Open Drawings</p>
    <p className="text-2xl font-bold text-green-600">
      {metrics.openDrawings}
    </p>
  </div>

  <div className="rounded-xl bg-white p-4 shadow">
    <p className="text-sm text-gray-500">Closed Drawings</p>
    <p className="text-2xl font-bold text-red-600">
      {metrics.closedDrawings}
    </p>
  </div>

  <div className="rounded-xl bg-white p-4 shadow">
    <p className="text-sm text-gray-500">Settled Drawings</p>
    <p className="text-2xl font-bold text-black">
      {metrics.settledDrawings}
    </p>
  </div>

  <div className="rounded-xl bg-white p-4 shadow">
    <p className="text-sm text-gray-500">Total Handle</p>
    <p className="text-2xl font-bold">
      {formatMoney(metrics.totalHandle)}
    </p>
  </div>

  <div className="rounded-xl bg-white p-4 shadow">
    <p className="text-sm text-gray-500">Potential Payout</p>
    <p className="text-2xl font-bold text-orange-600">
      {formatMoney(metrics.totalPotentialPayout)}
    </p>
  </div>

  <div className="rounded-xl bg-white p-4 shadow">
    <p className="text-sm text-gray-500">House Result</p>
    <p
      className={`text-2xl font-bold ${
        metrics.houseResult >= 0
          ? "text-green-700"
          : "text-red-700"
      }`}
    >
      {formatMoney(metrics.houseResult)}
    </p>
  </div>
</section>
<section className="mt-6 rounded-xl bg-white p-6 shadow">
  <div className="mb-4 flex items-center justify-between">
  <button
    onClick={() => setShowPrintableReport(!showPrintableReport)}
    className="text-left text-xl font-semibold"
  >
    {showPrintableReport ? "▼" : "▶"} Printable Report
  </button>

    <button
      onClick={printReport}
      className="rounded bg-slate-700 px-4 py-2 font-semibold text-white hover:bg-slate-800"
    >
      Print Report
    </button>
	  </div>
	
{showPrintableReport && (
<>
	  <div className="text-sm text-gray-700">
	    <p>
	      <span className="font-semibold">Report Period:</span>{" "}
      {reportFilters.fromDate || "Beginning"} to{" "}
      {reportFilters.toDate || "Today"}
    </p>

    <p>
      <span className="font-semibold">State:</span>{" "}
      {reportFilters.state || "All"}
    </p>

    <p>
      <span className="font-semibold">Game:</span>{" "}
      {reportFilters.game || "All"}
    </p>

    <p>
      <span className="font-semibold">Status:</span>{" "}
      {reportFilters.status || "All"}
    </p>
  </div>

  <div className="mt-4 grid gap-2 text-sm">
    <p>Total Games: {metrics.totalGames}</p>
    <p>Total Drawings: {metrics.totalDrawings}</p>
    <p>Open Drawings: {metrics.openDrawings}</p>
    <p>Closed Drawings: {metrics.closedDrawings}</p>
    <p>Settled Drawings: {metrics.settledDrawings}</p>
    <p>Total Handle: {formatMoney(metrics.totalHandle)}</p>
    <p>Potential Payout: {formatMoney(metrics.totalPotentialPayout)}</p>
	    <p>Actual Payout: {formatMoney(metrics.actualPayout)}</p>
	    <p>House Result: {formatMoney(metrics.houseResult)}</p>
	  </div>
</>
)}
</section>
<section className="mt-8 rounded-xl bg-white p-6 shadow">
  <button
    onClick={() => setShowCreateGame(!showCreateGame)}
    className="mb-4 flex w-full items-center justify-between text-left text-xl font-semibold text-gray-900"
  >
    <span>{showCreateGame ? "▼" : "▶"} Create Lottery Game</span>
  </button>

  {showCreateGame && (
    <form onSubmit={handleSubmit} className="grid gap-4">
  <div className="grid gap-4 md:grid-cols-2">
    <label className="grid gap-1">
      <span className="font-medium">State</span>
      <select
        name="state"
        value={form.state}
        onChange={handleChange}
        className="rounded border p-2 text-gray-900"
        required
      >
        <option value="">Select a state</option>
        {states.map((state) => (
          <option key={state.code} value={state.code}>
            {state.name}
          </option>
        ))}
      </select>
      <span className="text-sm text-gray-500">
        Choose the state this lottery game belongs to.
      </span>
    </label>

    <label className="grid gap-1">
      <span className="font-medium">Game Name</span>
      <input
        name="name"
        value={form.name}
        onChange={handleChange}
        placeholder="Example: Pick 4 Evening"
        className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
        required
      />
      <span className="text-sm text-gray-500">
        Example: Pick 3 Midday, Pick 4 Evening, Fantasy 5.
      </span>
    </label>
  </div>

  <label className="grid gap-1">
    <span className="font-medium">Game Type</span>
    <select
      name="gameType"
      value={form.gameType}
      onChange={handleChange}
      className="rounded border p-2 text-gray-900"
    >
      <option value="pick_n">Pick N</option>
      <option value="powerball_style">Powerball Style</option>
      <option value="keno_style">Keno Style</option>
    </select>
    <span className="text-sm text-gray-500">
      Pick N works for games like Pick 3, Pick 4, Pick 5.
    </span>
  </label>

  <div className="grid gap-4 md:grid-cols-3">
    <label className="grid gap-1">
      <span className="font-medium">Main Numbers Count</span>
      <input
        name="mainNumbersCount"
        value={form.mainNumbersCount}
        onChange={handleChange}
        placeholder="Example: 4"
        className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
        required
      />
      <span className="text-sm text-gray-500">How many numbers users pick.</span>
    </label>

    <label className="grid gap-1">
      <span className="font-medium">Main Min</span>
      <input
        name="mainNumbersMin"
        value={form.mainNumbersMin}
        onChange={handleChange}
        placeholder="Example: 0"
        className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
        required
      />
      <span className="text-sm text-gray-500">Lowest allowed number.</span>
    </label>

    <label className="grid gap-1">
      <span className="font-medium">Main Max</span>
      <input
        name="mainNumbersMax"
        value={form.mainNumbersMax}
        onChange={handleChange}
        placeholder="Example: 9"
        className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
        required
      />
      <span className="text-sm text-gray-500">Highest allowed number.</span>
    </label>
  </div>

  <div className="grid gap-4 md:grid-cols-3">
    <label className="grid gap-1">
      <span className="font-medium">Bonus Count</span>
      <input
        name="bonusNumbersCount"
        value={form.bonusNumbersCount}
        onChange={handleChange}
        placeholder="Example: 1"
        className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
      />
      <span className="text-sm text-gray-500">Leave blank if no bonus ball.</span>
    </label>

    <label className="grid gap-1">
      <span className="font-medium">Bonus Min</span>
      <input
        name="bonusNumbersMin"
        value={form.bonusNumbersMin}
        onChange={handleChange}
        placeholder="Example: 1"
        className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
      />
      <span className="text-sm text-gray-500">Lowest bonus number.</span>
    </label>

    <label className="grid gap-1">
      <span className="font-medium">Bonus Max</span>
      <input
        name="bonusNumbersMax"
        value={form.bonusNumbersMax}
        onChange={handleChange}
        placeholder="Example: 26"
        className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
      />
      <span className="text-sm text-gray-500">Highest bonus number.</span>
    </label>
  </div>

  <label className="grid gap-1">
    <span className="font-medium">Ticket Price</span>
    
    <input
      name="ticketPrice"
      value={form.ticketPrice}
      onChange={handleChange}
      placeholder="Example: 1.00"
      className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
      required
    />
    <span className="text-sm text-gray-500">
      Price per ticket.
    </span>
    <div className="grid gap-4 md:grid-cols-2">
  <label className="grid gap-1">
    <span className="font-medium">Payout Multiplier</span>
    <input
      name="payoutMultiplier"
      value={form.payoutMultiplier}
      onChange={handleChange}
      placeholder="Example: 5000"
      className="rounded border p-2 text-gray-900"
      required
    />
    <span className="text-sm text-gray-500">
      Multiplier applied to winning bets.
    </span>
  </label>

  <label className="grid gap-1">
    <span className="font-medium">Max Payout</span>
    <input
      name="maxPayout"
      value={form.maxPayout}
      onChange={handleChange}
      placeholder="Example: 100000"
      className="rounded border p-2 text-gray-900"
      required
    />
    <span className="text-sm text-gray-500">
      Maximum allowed payout per bet.
    </span>
  </label>
  </div>
  <div className="grid gap-4 md:grid-cols-3">
  <label className="flex flex-col gap-1">
    <span className="font-medium">Default Max Bet</span>
    <input
      name="defaultMaxBet"
      value={form.defaultMaxBet}
      onChange={handleChange}
      placeholder="Example: 100"
      className="rounded border p-2 text-gray-900"
    />
    <span className="text-sm text-gray-500">
      Default max bet inherited by generated drawings.
    </span>
  </label>

  <label className="flex flex-col gap-1">
    <span className="font-medium">Default Max Total Handle</span>
    <input
      name="defaultMaxTotalHandle"
      value={form.defaultMaxTotalHandle}
      onChange={handleChange}
      placeholder="Example: 25000"
      className="rounded border p-2 text-gray-900"
    />
    <span className="text-sm text-gray-500">
      Default handle cap inherited by generated drawings.
    </span>
  </label>

  <label className="flex flex-col gap-1">
    <span className="font-medium">Default Max Total Liability</span>
    <input
      name="defaultMaxTotalLiability"
      value={form.defaultMaxTotalLiability}
      onChange={handleChange}
      placeholder="Example: 100000"
      className="rounded border p-2 text-gray-900"
    />
    <span className="text-sm text-gray-500">
      Default liability cap inherited by generated drawings.
    </span>
  </label>
</div>
  </label>
  <div className="grid gap-4 md:grid-cols-2">
  <label className="grid gap-1">
    <span className="font-medium">Schedule Type</span>
    <select
      name="scheduleType"
      value={form.scheduleType}
      onChange={handleChange}
      className="rounded border p-2 text-gray-900"
    >
      <option value="one_time">One-Time / Manual Drawings</option>
      <option value="recurring">Recurring Drawings</option>
    </select>
    <span className="text-sm text-gray-500">
      Recurring games can generate daily drawing instances automatically.
    </span>
  </label>

  <label className="grid gap-1">
    <span className="font-medium">Recurring Frequency</span>
    <select
      name="recurringFrequency"
      value={form.recurringFrequency}
      onChange={handleChange}
      className="rounded border p-2 text-gray-900"
      disabled={form.scheduleType !== "recurring"}
    >
      <option value="daily">Daily</option>
      <option value="weekly">Weekly</option>
      <option value="custom">Custom</option>
    </select>
    <span className="text-sm text-gray-500">
      Used only when schedule type is recurring.
    </span>
  </label>
</div>

<div className="grid gap-4 md:grid-cols-3">
  <label className="grid gap-1">
    <span className="font-medium">Default Draw Time</span>
    <input
      type="time"
      name="defaultDrawTime"
      value={form.defaultDrawTime}
      onChange={handleChange}
      className="rounded border p-2 text-gray-900"
    />
    <span className="text-sm text-gray-500">
      Standard draw time for recurring drawings.
    </span>
  </label>

  <label className="grid gap-1">
    <span className="font-medium">Default Cutoff Time</span>
    <input
      type="time"
      name="defaultCutoffTime"
      value={form.defaultCutoffTime}
      onChange={handleChange}
      className="rounded border p-2 text-gray-900"
    />
    <span className="text-sm text-gray-500">
      Standard last-call time for accepting wagers.
    </span>
  </label>

  <label className="grid gap-1">
    <span className="font-medium">Default Time Zone</span>
    <select
      name="defaultTimeZone"
      value={form.defaultTimeZone}
      onChange={handleChange}
      className="rounded border p-2 text-gray-900"
    >
      <option value="America/New_York">Eastern (ET)</option>
      <option value="America/Chicago">Central (CT)</option>
      <option value="America/Denver">Mountain (MT)</option>
      <option value="America/Los_Angeles">Pacific (PT)</option>
      <option value="America/Anchorage">Alaska (AKT)</option>
      <option value="Pacific/Honolulu">Hawaii (HST)</option>
    </select>
    <span className="text-sm text-gray-500">
      Default timezone inherited by generated drawings.
    </span>
  </label>
</div>

        <button className="rounded bg-blue-600 px-4 py-2 font-semibold text-white">
        {editingGameIndex !== null ? "Update Game" : "Save Game"}
      </button>
    </form>
  )}
</section>


        <section className="mt-8 rounded-xl bg-white p-6 shadow">
  <h2 className="mb-4 text-xl font-semibold">Created Games</h2>

  <div className="mb-4 grid gap-3 rounded border bg-gray-50 p-4">
    <label className="grid gap-1">
      <span className="font-medium">Game to Generate Drawings For</span>
      <select
        value={selectedGameIndex}
        onChange={(e) => setSelectedGameIndex(e.target.value)}
        className="rounded border p-2 text-gray-900"
      >
        <option value="">All Recurring Games</option>
        {games.map((game: any, index: number) => (
          <option key={index} value={index}>
            {game.state} — {game.name}{" "}({game.status || "active"})

          </option>
        ))}
      </select>
      <span className="text-sm text-gray-500">
        Choose one game, or leave as all recurring games.
      </span>
    </label>

    <div className="flex gap-2">
      <button
        onClick={generateTodayDrawings}
        className="rounded bg-purple-600 px-4 py-2 font-semibold text-white transition hover:bg-purple-700 active:scale-95 active:bg-purple-800"
      >
        Generate Today
      </button>

      <button
        onClick={generateNext7Days}
        className="rounded bg-indigo-600 px-4 py-2 font-semibold text-white transition hover:bg-indigo-700 active:scale-95 active:bg-indigo-800"
      >
        Generate Next 7 Days
      </button>
    </div>
  </div>

  {games.length === 0 ? (
    <p className="text-gray-500">No games created yet.</p>
  ) : (
    <div className="space-y-3">
      {games.map((game: any, index: number) => (
        <div
  key={index}
  className="rounded border p-4 cursor-pointer"
  onClick={() => toggleGameDetails(index)}
>
          <p className="font-semibold">
  {expandedGameIds.includes(index) ? "▼" : "▶"}{" "}
  {game.state} — {game.name}{" "}
  <span className="text-xs text-gray-500">
    ({game.status || "active"})
  </span>
</p>
          <p className="text-sm text-gray-600">
  {game.gameType} | Pick {game.mainNumbersCount} from{" "}
  {game.mainNumbersMin}–{game.mainNumbersMax}
  {game.bonusNumbersCount
    ? ` and Bonus ${game.bonusNumbersCount} from ${game.bonusNumbersMin}–${game.bonusNumbersMax}`
    : ""}
  {" "} | Ticket: ${game.ticketPrice}
</p>
          {expandedGameIds.includes(index) && (
  <div className="mt-3 border-t pt-3 text-sm text-gray-700 space-y-1">
    <p>
  <span className="font-semibold">Status:</span>{" "}
  {game.status || "Active"}
</p>
    <p>
      
      <span className="font-semibold">Payout Multiplier:</span>{" "}
      {game.payoutMultiplier}
    </p>
    
    <p>
  <span className="font-semibold">Bonus Count:</span>{" "}
  {game.bonusNumbersCount || "None"}
</p>

{game.bonusNumbersCount && (
  <p>
    <span className="font-semibold">Bonus Range:</span>{" "}
    {game.bonusNumbersMin}–{game.bonusNumbersMax}
  </p>
)}

    <p>
      <span className="font-semibold">Max Payout:</span>{" "}
      {formatMoney(game.maxPayout)}
    </p>

    <p>
      <span className="font-semibold">Default Max Bet:</span>{" "}
      {formatMoney(game.defaultMaxBet)}
    </p>

    <p>
      <span className="font-semibold">Default Max Handle:</span>{" "}
      {formatMoney(game.defaultMaxTotalHandle)}
    </p>

    <p>
      <span className="font-semibold">Default Max Liability:</span>{" "}
      {formatMoney(game.defaultMaxTotalLiability)}
    </p>

    <p>
      <span className="font-semibold">Schedule Type:</span>{" "}
      {game.scheduleType}
    </p>

    <p>
      <span className="font-semibold">Recurring Frequency:</span>{" "}
      {game.recurringFrequency}
    </p>

    <p>
      <span className="font-semibold">Default Draw Time:</span>{" "}
      {game.defaultDrawTime || "N/A"}
    </p>

    <p>
      <span className="font-semibold">Default Cutoff Time:</span>{" "}
      {game.defaultCutoffTime || "N/A"}
    </p>

    <p>
      <span className="font-semibold">Time Zone:</span>{" "}
      {game.defaultTimeZone}
    </p>
    <div className="mt-4 flex gap-2">
<button
  onClick={(e) => {
    e.stopPropagation();
    editGame(index);
  }}
  className="rounded bg-blue-600 px-3 py-1 text-sm font-semibold text-white hover:bg-blue-700"
>
  Edit
</button>
  <button
    onClick={(e) => {
      e.stopPropagation();
      disableGame(index);
    }}
  
  className="rounded bg-yellow-500 px-3 py-1 text-sm font-semibold text-white hover:bg-yellow-600"

>
    Disable
  </button>

  <button
    onClick={(e) => {
      e.stopPropagation();
      archiveGame(index);
    }}
    className="rounded bg-gray-600 px-3 py-1 text-sm font-semibold text-white hover:bg-gray-700"
  >
    Archive
  </button>

  <button
    onClick={(e) => {
      e.stopPropagation();
      deleteGame(index);
    }}
    className="rounded bg-red-600 px-3 py-1 text-sm font-semibold text-white hover:bg-red-700"
  >
    Delete
  </button>
</div>
  </div>
)}
        </div>
      ))}
    </div>
  )}
</section>

        <section className="mt-8 rounded-xl bg-white p-6 shadow">
          <button
  onClick={() => setShowCreateDrawing(!showCreateDrawing)}
  className="mb-4 flex w-full items-center justify-between text-left text-xl font-semibold"
>
  <span> {showCreateDrawing ? "▼" : "▶"} Create Drawing</span>
</button>


          {showCreateDrawing && (
  <>
    {games.length === 0 ? (
  <p className="text-gray-500">
    Create a lottery game first before adding drawings.
  </p>
) : (
  <form onSubmit={handleDrawingSubmit} className="grid gap-4">
    <label className="grid gap-1">
  <span className="font-medium">Time Zone</span>
  <select
    name="timeZone"
    value={drawingForm.timeZone}
    onChange={handleDrawingChange}
    className="rounded border p-2 text-gray-900"
  >
    <option value="America/New_York">Eastern (ET)</option>
    <option value="America/Chicago">Central (CT)</option>
    <option value="America/Denver">Mountain (MT)</option>
    <option value="America/Los_Angeles">Pacific (PT)</option>
    <option value="America/Anchorage">Alaska (AKT)</option>
    <option value="Pacific/Honolulu">Hawaii (HST)</option>
  </select>
  <span className="text-sm text-gray-500">
    Default is Eastern Time for U.S. lottery drawings.
  </span>
</label>
    <label className="grid gap-1">
      <span className="font-medium">Lottery Game</span>
      <select
        name="gameIndex"
        value={drawingForm.gameIndex}
        onChange={handleDrawingChange}
        className="rounded border p-2 text-gray-900"
        required
      >
        <option value="">Select a game</option>
        {games.map((game, index) => (
          <option key={index} value={index}>
            {game.state} — {game.name}
          </option>
        ))}
      </select>
      <span className="text-sm text-gray-500">
        Choose which configured lottery game this drawing belongs to.
      </span>
    </label>

    <div className="grid gap-4 md:grid-cols-3">
      <label className="grid gap-1">
        <span className="font-medium">Draw Date</span>
        <input
          type="date"
          name="drawDate"
          value={drawingForm.drawDate}
          onChange={handleDrawingChange}
          className="rounded border p-2 text-gray-900"
          required
        />
        <span className="text-sm text-gray-500">
          Date the drawing will take place.
        </span>
      </label>

      <label className="grid gap-1">
        <span className="font-medium">Draw Time</span>
        <input
          type="time"
          name="drawTime"
          value={drawingForm.drawTime}
          onChange={handleDrawingChange}
          className="rounded border p-2 text-gray-900"
          required
        />
        <span className="text-sm text-gray-500">
          Official drawing time.
        </span>
      </label>

      <label className="grid gap-1">
        <span className="font-medium">Cutoff Time</span>
        <input
          type="time"
          name="cutoffTime"
          value={drawingForm.cutoffTime}
          onChange={handleDrawingChange}
          className="rounded border p-2 text-gray-900"
          required
        />
        <span className="text-sm text-gray-500">
          Last time users can place wagers.
        </span>
      </label>
    </div>
<label className="grid gap-1">
  <span className="font-medium">Drawing Status</span>
  <select
    name="status"
    value={drawingForm.status}
    onChange={handleDrawingChange}
    className="rounded border p-2 text-gray-900"
  >
    <option value="scheduled">Scheduled</option>
    <option value="open">Open</option>
    <option value="closed">Closed</option>
    <option value="resulted">Resulted</option>
    <option value="settled">Settled</option>
  </select>
  <span className="text-sm text-gray-500">
    Controls where the drawing is in its lifecycle.
  </span>
</label>
    <div className="grid gap-4 md:grid-cols-3">
      <label className="grid gap-1">
        <span className="font-medium">Max Bet</span>
        <input
          name="maxBet"
          value={drawingForm.maxBet}
          onChange={handleDrawingChange}
          placeholder="Example: 100"
          className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
          required
        />
        <span className="text-sm text-gray-500">
          Maximum wager allowed per ticket.
        </span>
      </label>

      <label className="grid gap-1">
        <span className="font-medium">Max Total Handle</span>
        <input
          name="maxTotalHandle"
          value={drawingForm.maxTotalHandle}
          onChange={handleDrawingChange}
          placeholder="Example: 25000"
          className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
          required
        />
        <span className="text-sm text-gray-500">
          Maximum total wagers accepted for this drawing.
        </span>
      </label>

      <label className="grid gap-1">
        <span className="font-medium">Max Total Liability</span>
        <input
          name="maxTotalLiability"
          value={drawingForm.maxTotalLiability}
          onChange={handleDrawingChange}
          placeholder="Example: 100000"
          className="rounded border p-2 text-gray-900 placeholder:text-gray-400"
          required
        />
        <span className="text-sm text-gray-500">
          Maximum possible payout exposure for this drawing.
        </span>
      </label>
    </div>

        <button className="rounded bg-green-600 px-4 py-2 font-semibold text-white">
      Save Drawing
    </button>
    </form>
  )}
</>
)}
</section>

        <section className="mt-8 rounded-xl bg-white p-6 shadow">
  <h2 className="mb-4 text-xl font-semibold">Created Drawings</h2>

  {drawings.length === 0 ? (
    <p className="text-gray-500">No drawings created yet.</p>
  ) : (
    <div className="space-y-3">
      {drawings.map((drawing: any, index: number) => {
        const drawDateTime = new Date(`${drawing.drawDate}T${drawing.drawTime}`);
        const cutoffDateTime = new Date(`${drawing.drawDate}T${drawing.cutoffTime}`);

        const drawingTime = new Intl.DateTimeFormat("en-US", {
          timeZone:
  drawing.timeZone &&
  drawing.timeZone !== "DEFAULT_TIME_ZONE"
    ? drawing.timeZone
    : "America/New_York",
          dateStyle: "medium",
          timeStyle: "short",
        }).format(drawDateTime);

        const cutoffTime = new Intl.DateTimeFormat("en-US", {
          timeZone:
  drawing.timeZone &&
  drawing.timeZone !== "DEFAULT_TIME_ZONE"
    ? drawing.timeZone
    : "America/New_York",
          dateStyle: "medium",
          timeStyle: "short",
        }).format(cutoffDateTime);

        const userLocalDrawTime = new Intl.DateTimeFormat("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(drawDateTime);

        return (
          <div
            key={drawing.id || index}
            className="rounded border p-4 cursor-pointer"
            onClick={() => toggleDrawingDetails(drawing.id)}
          >
            <p className="font-semibold">
              {expandedDrawingIds.includes(drawing.id) ? "▼" : "▶"}{" "}
              {drawing.game.state} — {drawing.game.name}
            </p>

            <p className="text-xs text-gray-500">ID: {drawing.id}</p>

            <p className="text-sm text-gray-600">
              Draw: {drawingTime} (
              {drawing.timeZone.replace("America/", "").replace("_", " ")}) |
              Cutoff: {cutoffTime} |Status:{" "}
<span className={drawing.status === "settled" ? "font-bold text-black" : ""}>
  {drawing.status === "settled" ? "SETTLED" : getDrawingStatus(drawing)}
</span>
              <br />
              Your local draw time: {userLocalDrawTime}
            </p>

            <p className="text-sm text-gray-600">
              Max bet: {formatMoney(drawing.maxBet)} | Max handle:{" "}
              {formatMoney(drawing.maxTotalHandle)} | Max liability:{" "}
              {formatMoney(drawing.maxTotalLiability)}
            </p>

            <p className="text-sm font-medium text-blue-700">
              Handle: {formatMoney(drawing.totalHandle)} | Potential Payout:{" "}
              {formatMoney(drawing.totalPotentialPayout)}
            </p>

            <p className="text-sm text-red-600">
              Worst Case Liability: {formatMoney(drawing.worstCaseLiability)}
            </p>

            <p className="text-sm text-green-700">
              House Position: {formatMoney(drawing.housePosition)}
            </p>

            {expandedDrawingIds.includes(drawing.id) && (
              <>
                {drawing.bets && drawing.bets.length > 0 && (
                  <>
                    <div className="mt-3 border-t pt-2">
                      <p className="text-sm font-semibold text-gray-700">
                        Bets:
                      </p>

                      {drawing.bets.map((bet: any) => (
                        <div key={bet.id} className="text-xs text-gray-600">
                          #{bet.id} | {bet.numbers} | {bet.betType}
                          {bet.betType === "box"
                            ? ` (${getBoxWayCount(bet.numbers)}-way)`
                            : ""}
                          | {formatMoney(bet.amount)} →{" "}
                          {formatMoney(bet.potentialPayout)}
                        </div>
                      ))}
                    </div>

                    <div
  className="mt-3 border-t pt-2"
  onClick={(e) => e.stopPropagation()}
>
                      <p className="text-sm font-semibold text-red-700">
                        Exposure by Number Combination:
                      </p>

                      {getExposureByNumbers(drawing).map((item) => (
                        <div key={item.numbers} className="text-xs text-gray-700">
                          {item.numbers} → {formatMoney(item.payout)}
                        </div>
                        
                     
))}
</div>

<div
  className="mt-3 border-t pt-2"
  onClick={(e) => e.stopPropagation()}
>
  <p className="text-sm font-semibold text-gray-700">
    Enter Result:
  </p>

  <input
    placeholder="Winning numbers, example: 1-2-3-4"
    value={drawing.winningNumbers || ""}
    disabled={drawing.status === "settled"}
    onChange={(e) =>
      updateDrawingResult(index, "winningNumbers", e.target.value)
    }
    className={`mt-2 w-full rounded border p-2 ${
  drawing.status === "settled"
    ? "bg-gray-200 text-gray-500 cursor-not-allowed"
    : "text-gray-900"
}`}
  />

  <input
    placeholder="Bonus number, if any"
    value={drawing.winningBonus || ""}
    disabled={drawing.status === "settled"}
    onChange={(e) =>
      updateDrawingResult(index, "winningBonus", e.target.value)
    }
    className={`mt-2 w-full rounded border p-2 ${
  drawing.status === "settled"
    ? "bg-gray-200 text-gray-500 cursor-not-allowed"
    : "text-gray-900"
}`}
  />

  <input
    placeholder="Result source, example: Florida Lottery"
    value={drawing.resultSource || ""}
    disabled={drawing.status === "settled"}
    onChange={(e) =>
      updateDrawingResult(index, "resultSource", e.target.value)
    }
    className={`mt-2 w-full rounded border p-2 ${
  drawing.status === "settled"
    ? "bg-gray-200 text-gray-500 cursor-not-allowed"
    : "text-gray-900"
}`}
  />
  <button
  onClick={(e) => {
    e.stopPropagation();
    settleDrawing(index);
  }}
  className="mt-3 rounded bg-green-600 px-4 py-2 font-semibold text-white hover:bg-green-700"
>
  Settle Drawing
</button>
</div>
{drawing.status === "settled" && drawing.bets && drawing.bets.length > 0 && (
  <div className="mt-4 border-t pt-3">
    <p className="text-lg font-bold text-black">Ticket Results</p>

    {drawing.bets.map((bet: any) => (
      <div
        key={bet.id}
        className="mt-2 rounded border p-2 text-sm text-gray-800"
      >
        
        <p className="font-semibold">
          #{bet.id} — {bet.status === "winner" ? "WINNER" : "LOSER"}
        </p>
        <p>Numbers: {bet.numbers}</p>
        <p>Bet Type: {bet.betType}</p>
        <p>Amount: {formatMoney(bet.amount)}</p>
        <p>Potential Payout: {formatMoney(bet.potentialPayout)}</p>
      </div>
      
    ))}
    {drawing.overrideReason && (
  <div className="mt-4 rounded border border-yellow-400 bg-yellow-50 p-3 text-sm text-yellow-900">
    <p className="font-bold">Override / Reopen Audit</p>
    <p>Reason: {drawing.overrideReason}</p>
    <p>
      Reopened At:{" "}
      {drawing.reopenedAt
        ? new Date(drawing.reopenedAt).toLocaleString()
        : "N/A"}
    </p>
  </div>
)}
    {drawing.status === "settled" && (
  <div className="mt-4 border-t pt-3">
    <p className="text-sm font-semibold text-gray-700">
      Reopen / Override
    </p>

    <input
      placeholder="Override reason required"
      value={overrideReason}
      onChange={(e) => setOverrideReason(e.target.value)}
      className="mt-2 w-full rounded border p-2 text-gray-900"
      onClick={(e) => e.stopPropagation()}
    />

    <button
      onClick={(e) => {
        e.stopPropagation();
        reopenDrawing(index);
      }}
      className="mt-3 rounded bg-red-700 px-4 py-2 font-semibold text-white hover:bg-red-800"
    >
      Reopen Drawing
    </button>
  </div>
)}
  </div>
)}
                  </>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  )}
</section>

        <section className="mt-8 rounded-xl bg-white p-6 shadow">
  <h2 className="mb-4 text-xl font-semibold">Mock Bet (Admin Test)</h2>

  {drawings.length === 0 ? (
    <p className="text-gray-500">Create drawings first to place mock bets.</p>
  ) : (
    <form onSubmit={handleMockBetSubmit} className="grid gap-4">
      <label className="grid gap-1">
        <span className="font-medium">Select Drawing</span>
        <select
          name="drawingId"
          value={mockBetForm.drawingId}
          onChange={handleMockBetChange}
          className="rounded border p-2 text-gray-900"
          required
        >
          <option value="">Select a drawing</option>
          {drawings.map((drawing: any, index: number) => (
  <option key={drawing.id || index} value={drawing.id}>
    {drawing.id}
  </option>
))}
            
        
        </select>
      </label>
<label className="grid gap-1">
  <span className="font-medium">Bet Type</span>
  <select
    name="betType"
    value={mockBetForm.betType}
    onChange={handleMockBetChange}
    className="rounded border p-2 text-gray-900"
    required
  >
    <option value="straight">Straight</option>
    <option value="box">Box</option>
    <option value="straight_box">Straight + Box</option>
  </select>
  <span className="text-sm text-gray-500">
    Straight pays full multiplier. Box pays reduced multiplier.
  </span>
</label>
      <label className="grid gap-1">
        <span className="font-medium">Numbers</span>
        <input 
                name="numbers"
                value={mockBetForm.numbers}
                onChange={handleMockBetChange}
                placeholder="Use hyphens: 1-2-3-4 or 10-23-45-52-69"
                pattern="^\d+(-\d+)*$"
                title="Enter numbers separated by hyphens (e.g., 1-2-3-4)"
                className="rounded border p-2 text-gray-900"
  required
/>
      </label>

      <label className="grid gap-1">
        <span className="font-medium">Bet Amount</span>
        <input
          name="amount"
          value={mockBetForm.amount}
          onChange={handleMockBetChange}
          placeholder="Example: 1"
          className="rounded border p-2 text-gray-900"
          required
        />
      </label>

      

      <button className="rounded bg-orange-600 px-4 py-2 font-semibold text-white transition active:scale-95 active:bg-orange-800 hover:bg-orange-700">
        Submit Mock Bet
      </button>
    </form>
  )}
</section>
      </div>
    </main>
  );
}
