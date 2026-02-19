# LeaguesApi

All URIs are relative to *https://api.clashofclans.com/v1*

|Method | HTTP request | Description|
|------------- | ------------- | -------------|
|[**getLeague**](#getleague) | **GET** /leagues/{leagueId} | Get league information|
|[**getLeagueSeasonRankings**](#getleagueseasonrankings) | **GET** /leagues/{leagueId}/seasons/{seasonId} | Get league season rankings|
|[**getLeagueSeasons**](#getleagueseasons) | **GET** /leagues/{leagueId}/seasons | Get league seasons|
|[**getLeagues**](#getleagues) | **GET** /leagues | List leagues|
|[**getWarLeague**](#getwarleague) | **GET** /warleagues/{leagueId} | Get war league information|
|[**getWarLeagues**](#getwarleagues) | **GET** /warleagues | List war leagues|

# **getLeague**
> League getLeague()

Get league information

### Example

```typescript
import {
    LeaguesApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new LeaguesApi(configuration);

let leagueId: string; //Identifier of the league. (default to undefined)

const { status, data } = await apiInstance.getLeague(
    leagueId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **leagueId** | [**string**] | Identifier of the league. | defaults to undefined|


### Return type

**League**

### Authorization

[JWT](../README.md#JWT)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Successful response |  -  |
|**400** | Client provided incorrect parameters for the request. |  -  |
|**403** | Access denied, either because of missing/incorrect credentials or used API token does not grant access to the requested resource.  |  -  |
|**404** | Resource was not found. |  -  |
|**429** | Request was throttled, because amount of requests was above the threshold defined for the used API token.  |  -  |
|**500** | Unknown error happened when handling the request. |  -  |
|**503** | Service is temprorarily unavailable because of maintenance. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getLeagueSeasonRankings**
> PlayerRankingList getLeagueSeasonRankings()

Get league season rankings. Note that league season information is available only for Legend League. 

### Example

```typescript
import {
    LeaguesApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new LeaguesApi(configuration);

let leagueId: string; //Identifier of the league. (default to undefined)
let seasonId: string; //Identifier of the season. (default to undefined)
let limit: number; //Limit the number of items returned in the response. (optional) (default to undefined)
let after: string; //Return only items that occur after this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)
let before: string; //Return only items that occur before this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)

const { status, data } = await apiInstance.getLeagueSeasonRankings(
    leagueId,
    seasonId,
    limit,
    after,
    before
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **leagueId** | [**string**] | Identifier of the league. | defaults to undefined|
| **seasonId** | [**string**] | Identifier of the season. | defaults to undefined|
| **limit** | [**number**] | Limit the number of items returned in the response. | (optional) defaults to undefined|
| **after** | [**string**] | Return only items that occur after this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|
| **before** | [**string**] | Return only items that occur before this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|


### Return type

**PlayerRankingList**

### Authorization

[JWT](../README.md#JWT)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Successful response |  -  |
|**400** | Client provided incorrect parameters for the request. |  -  |
|**403** | Access denied, either because of missing/incorrect credentials or used API token does not grant access to the requested resource.  |  -  |
|**404** | Resource was not found. |  -  |
|**429** | Request was throttled, because amount of requests was above the threshold defined for the used API token.  |  -  |
|**500** | Unknown error happened when handling the request. |  -  |
|**503** | Service is temprorarily unavailable because of maintenance. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getLeagueSeasons**
> LeagueSeasonList getLeagueSeasons()

Get league seasons. Note that league season information is available only for Legend League. 

### Example

```typescript
import {
    LeaguesApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new LeaguesApi(configuration);

let leagueId: string; //Identifier of the league. (default to undefined)
let limit: number; //Limit the number of items returned in the response. (optional) (default to undefined)
let after: string; //Return only items that occur after this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)
let before: string; //Return only items that occur before this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)

const { status, data } = await apiInstance.getLeagueSeasons(
    leagueId,
    limit,
    after,
    before
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **leagueId** | [**string**] | Identifier of the league. | defaults to undefined|
| **limit** | [**number**] | Limit the number of items returned in the response. | (optional) defaults to undefined|
| **after** | [**string**] | Return only items that occur after this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|
| **before** | [**string**] | Return only items that occur before this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|


### Return type

**LeagueSeasonList**

### Authorization

[JWT](../README.md#JWT)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Successful response |  -  |
|**400** | Client provided incorrect parameters for the request. |  -  |
|**403** | Access denied, either because of missing/incorrect credentials or used API token does not grant access to the requested resource.  |  -  |
|**404** | Resource was not found. |  -  |
|**429** | Request was throttled, because amount of requests was above the threshold defined for the used API token.  |  -  |
|**500** | Unknown error happened when handling the request. |  -  |
|**503** | Service is temprorarily unavailable because of maintenance. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getLeagues**
> LeagueList getLeagues()

List leagues

### Example

```typescript
import {
    LeaguesApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new LeaguesApi(configuration);

let limit: number; //Limit the number of items returned in the response. (optional) (default to undefined)
let after: string; //Return only items that occur after this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)
let before: string; //Return only items that occur before this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)

const { status, data } = await apiInstance.getLeagues(
    limit,
    after,
    before
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **limit** | [**number**] | Limit the number of items returned in the response. | (optional) defaults to undefined|
| **after** | [**string**] | Return only items that occur after this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|
| **before** | [**string**] | Return only items that occur before this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|


### Return type

**LeagueList**

### Authorization

[JWT](../README.md#JWT)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Successful response |  -  |
|**400** | Client provided incorrect parameters for the request. |  -  |
|**403** | Access denied, either because of missing/incorrect credentials or used API token does not grant access to the requested resource.  |  -  |
|**404** | Resource was not found. |  -  |
|**429** | Request was throttled, because amount of requests was above the threshold defined for the used API token.  |  -  |
|**500** | Unknown error happened when handling the request. |  -  |
|**503** | Service is temprorarily unavailable because of maintenance. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getWarLeague**
> WarLeague getWarLeague()

Get war league information

### Example

```typescript
import {
    LeaguesApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new LeaguesApi(configuration);

let leagueId: string; //Identifier of the league. (default to undefined)

const { status, data } = await apiInstance.getWarLeague(
    leagueId
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **leagueId** | [**string**] | Identifier of the league. | defaults to undefined|


### Return type

**WarLeague**

### Authorization

[JWT](../README.md#JWT)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Successful response |  -  |
|**400** | Client provided incorrect parameters for the request. |  -  |
|**403** | Access denied, either because of missing/incorrect credentials or used API token does not grant access to the requested resource.  |  -  |
|**404** | Resource was not found. |  -  |
|**429** | Request was throttled, because amount of requests was above the threshold defined for the used API token.  |  -  |
|**500** | Unknown error happened when handling the request. |  -  |
|**503** | Service is temprorarily unavailable because of maintenance. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

# **getWarLeagues**
> WarLeagueList getWarLeagues()

List war leagues

### Example

```typescript
import {
    LeaguesApi,
    Configuration
} from './api';

const configuration = new Configuration();
const apiInstance = new LeaguesApi(configuration);

let limit: number; //Limit the number of items returned in the response. (optional) (default to undefined)
let after: string; //Return only items that occur after this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)
let before: string; //Return only items that occur before this marker. Before marker can be found from the response, inside the \'paging\' property. Note that only after or before can be specified for a request, not both.  (optional) (default to undefined)

const { status, data } = await apiInstance.getWarLeagues(
    limit,
    after,
    before
);
```

### Parameters

|Name | Type | Description  | Notes|
|------------- | ------------- | ------------- | -------------|
| **limit** | [**number**] | Limit the number of items returned in the response. | (optional) defaults to undefined|
| **after** | [**string**] | Return only items that occur after this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|
| **before** | [**string**] | Return only items that occur before this marker. Before marker can be found from the response, inside the \&#39;paging\&#39; property. Note that only after or before can be specified for a request, not both.  | (optional) defaults to undefined|


### Return type

**WarLeagueList**

### Authorization

[JWT](../README.md#JWT)

### HTTP request headers

 - **Content-Type**: Not defined
 - **Accept**: application/json


### HTTP response details
| Status code | Description | Response headers |
|-------------|-------------|------------------|
|**200** | Successful response |  -  |
|**400** | Client provided incorrect parameters for the request. |  -  |
|**403** | Access denied, either because of missing/incorrect credentials or used API token does not grant access to the requested resource.  |  -  |
|**404** | Resource was not found. |  -  |
|**429** | Request was throttled, because amount of requests was above the threshold defined for the used API token.  |  -  |
|**500** | Unknown error happened when handling the request. |  -  |
|**503** | Service is temprorarily unavailable because of maintenance. |  -  |

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

