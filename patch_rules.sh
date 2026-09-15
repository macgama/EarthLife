#!/bin/bash
sed -i 's/match \/features\/{featureId} {/match \/features\/{featureId} {\n        allow read, write: if true;\n      }\n      match \/populationSlots\/{slotId} {/g' firestore.rules
