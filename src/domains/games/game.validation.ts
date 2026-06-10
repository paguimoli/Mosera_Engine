import { invalid, valid } from "@/src/lib/validation/validation.types";
import { parseAvailableSpots } from "./game.service";

export function validateGameForm(form: any) {
  if (form.gameType === "keno_style") {
    const numberRangeMin = Number(form.numberRangeMin || 0);
    const numberRangeMax = Number(form.numberRangeMax || 0);
    const numbersDrawn = Number(form.numbersDrawn || 0);
    const availableSpots = parseAvailableSpots(String(form.availableSpots || ""));
    const drawIntervalSeconds = Number(form.drawIntervalSeconds || 0);
    const drawIdPrefix = String(form.drawIdPrefix || "").trim();

    if (
      numberRangeMin <= 0 ||
      numberRangeMax <= 0 ||
      numberRangeMin >= numberRangeMax ||
      numbersDrawn <= 0 ||
      numbersDrawn > numberRangeMax - numberRangeMin + 1 ||
      availableSpots.length === 0 ||
      drawIntervalSeconds <= 0 ||
      drawIdPrefix === ""
    ) {
      return invalid(
        "Please enter a valid Keno range, draw count, spot levels, draw interval, and draw ID prefix."
      );
    }

    return valid();
  }

  if (
    !form.state ||
    !form.mainNumbersCount ||
    !form.mainNumbersMin ||
    !form.mainNumbersMax ||
    !form.payoutMultiplier
  ) {
    return invalid(
      "Please enter the lottery state, main number count, range, and payout multiplier."
    );
  }

  return valid();
}
