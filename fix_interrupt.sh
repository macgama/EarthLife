#!/bin/bash
sed -i 's/onClick={() => handleAction(cancelAction(c, gameTimeMinutes))}/onClick={() => handleAction(cancelAction(c, gameTimeMinutes))}/g' src/components/survival/CharacterCard.tsx

sed -i 's/<button/<button/g' src/components/survival/CharacterCard.tsx

