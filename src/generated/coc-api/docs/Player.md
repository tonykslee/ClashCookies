# Player


## Properties

Name | Type | Description | Notes
------------ | ------------- | ------------- | -------------
**clan** | [**PlayerClan**](PlayerClan.md) |  | [optional] [readonly] [default to undefined]
**league** | [**League**](League.md) |  | [optional] [readonly] [default to undefined]
**role** | [**Role**](Role.md) |  | [optional] [readonly] [default to undefined]
**warPreference** | [**WarPreference**](WarPreference.md) |  | [optional] [readonly] [default to undefined]
**attackWins** | **number** |  | [optional] [readonly] [default to undefined]
**defenseWins** | **number** |  | [optional] [readonly] [default to undefined]
**townHallLevel** | **number** |  | [optional] [readonly] [default to undefined]
**townHallWeaponLevel** | **number** |  | [optional] [readonly] [default to undefined]
**versusBattleWins** | **number** |  | [optional] [readonly] [default to undefined]
**legendStatistics** | [**PlayerLegendStatistics**](PlayerLegendStatistics.md) |  | [optional] [readonly] [default to undefined]
**troops** | [**Array&lt;PlayerItemLevel&gt;**](PlayerItemLevel.md) |  | [optional] [readonly] [default to undefined]
**heroes** | [**Array&lt;PlayerItemLevel&gt;**](PlayerItemLevel.md) |  | [optional] [readonly] [default to undefined]
**spells** | [**Array&lt;PlayerItemLevel&gt;**](PlayerItemLevel.md) |  | [optional] [readonly] [default to undefined]
**labels** | [**Array&lt;Label&gt;**](Label.md) |  | [optional] [readonly] [default to undefined]
**tag** | **string** |  | [optional] [readonly] [default to undefined]
**name** | **string** |  | [optional] [readonly] [default to undefined]
**expLevel** | **number** |  | [optional] [readonly] [default to undefined]
**trophies** | **number** |  | [optional] [readonly] [default to undefined]
**bestTrophies** | **number** |  | [optional] [readonly] [default to undefined]
**donations** | **number** |  | [optional] [readonly] [default to undefined]
**donationsReceived** | **number** |  | [optional] [readonly] [default to undefined]
**builderHallLevel** | **number** |  | [optional] [readonly] [default to undefined]
**versusTrophies** | **number** |  | [optional] [readonly] [default to undefined]
**bestVersusTrophies** | **number** |  | [optional] [readonly] [default to undefined]
**warStars** | **number** |  | [optional] [readonly] [default to undefined]
**achievements** | [**Array&lt;PlayerAchievementProgress&gt;**](PlayerAchievementProgress.md) |  | [optional] [readonly] [default to undefined]
**versusBattleWinCount** | **number** |  | [optional] [readonly] [default to undefined]

## Example

```typescript
import { Player } from './api';

const instance: Player = {
    clan,
    league,
    role,
    warPreference,
    attackWins,
    defenseWins,
    townHallLevel,
    townHallWeaponLevel,
    versusBattleWins,
    legendStatistics,
    troops,
    heroes,
    spells,
    labels,
    tag,
    name,
    expLevel,
    trophies,
    bestTrophies,
    donations,
    donationsReceived,
    builderHallLevel,
    versusTrophies,
    bestVersusTrophies,
    warStars,
    achievements,
    versusBattleWinCount,
};
```

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
